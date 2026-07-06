/**
 * The native service-launch seam (plan §7.2 "M4 — Native partial-stack").
 *
 * M4's headline payoff is `stack up --only <svc,…>` booting ONLY the computed
 * dependency closure FOR REAL — natively, not by shelling out to up.sh. The one
 * thing that native path can't keep pure is the actual launch: spawning each
 * service's `pnpm dev` as a BACKGROUND process and health-polling it. That IO
 * lives behind this injectable `ServiceLauncher`, mirroring the `Runner` process
 * seam (exec.ts), the `HealthProber` HTTP seam (health.ts), and the `SnapshotIO`
 * seam (snapshot.ts).
 *
 * This is a FAITHFUL port of up.sh's `launch` (~1363-1372) + `wait_healthy`
 * (~1360) + the pid-file bookkeeping `services_down` (~1817) reads back:
 *   - probe the service's health URL ONCE first; a 200 ⇒ "already up" (idempotent
 *     re-run, exactly up.sh's `port_is_up && ok "$name already up"`).
 *   - else `( cd dir; env … nohup pnpm dev >$STATE/<id>.log 2>&1 & echo $! >$STATE/<id>.pid )`
 *     — a DETACHED background child whose pid is recorded under STATE.
 *   - then poll the health URL up to ~40×/1s (`wait_healthy`); a 200 within the
 *     window ⇒ ok, otherwise the launch is a failure (the caller aborts before
 *     reset/seed/login, matching up.sh's `SERVICES_RC`).
 * `stopServices(ids)` is the down path: read each pid file and kill the process —
 * what `services_down` does for a natively-launched partial stack.
 *
 * Production wires `makeRealLauncher()` (the ONLY place a real `pnpm dev` child
 * is spawned); the native `stack up --only` TESTS substitute a fake (via
 * `BaseCommand.prototype.getLauncher`) that records the `LaunchSpec`s and returns
 * canned results — so the topo-wave launch order, the per-service env, and the
 * health gating are asserted WITHOUT spawning a real process. Even the real
 * launcher's spawn/fs/poll are injectable deps so its OWN logic (already-up
 * short-circuit, pid-file write, poll-until-healthy, poll-timeout) is unit-tested
 * with fakes — no real IO under test.
 *
 * INVARIANT (plan hard constraint): spawning lives ONLY in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRealProber } from './health.js';
import type { HealthProber } from './health.js';

/** Default scratch/state dir for pid + log files — up.sh's `STATE=/tmp/sds-synthetic`. */
export const DEFAULT_STATE_DIR = '/tmp/sds-synthetic';

/**
 * A fully-resolved request to launch one service. The native `services_up`
 * planner produces this (resolving the manifest `launch.cmd`/`launch.env`
 * tokens, the cwd from the repo root + subpath, and the health URL from the
 * stack lane + health path); the launcher consumes it. Everything is explicit so
 * a fake launcher can assert on it byte-for-byte.
 */
export interface LaunchSpec {
  /** The service id (e.g. `iam-api`) — names the pid/log files under STATE. */
  id: string;
  /** Working directory the child runs in (the service's app dir). */
  cwd: string;
  /** Executable to run, e.g. `pnpm` (from the manifest `launch.cmd`). */
  command: string;
  /** argv handed to `command`, e.g. `['dev']`. */
  args: string[];
  /**
   * Extra/override env layered ON TOP of the parent environment by the real
   * launcher — the fully-resolved per-service launch env (the up.sh `launch_if`
   * line). A fake launcher records exactly this map.
   */
  env: Record<string, string>;
  /** Health URL polled for a 200, e.g. `http://localhost:3010/health`. */
  healthUrl: string;
}

/** The outcome of launching one service. */
export interface LaunchResult {
  /** The service id from the spec. */
  id: string;
  /** True iff the service answered a 200 within the health window (already-up counts). */
  ok: boolean;
  /** The spawned child's pid, or undefined when it was already up (no spawn) / spawn failed. */
  pid?: number;
  /** True iff a 200 came back BEFORE we launched — up.sh's "already up :$port" path. */
  alreadyUp?: boolean;
}

/** The outcome of stopping one service (the down path). */
export interface StopResult {
  id: string;
  /** True iff a pid file was found and a kill signal was delivered without throwing. */
  stopped: boolean;
  /** The pid read from the pid file, when present. */
  pid?: number;
}

/**
 * The injectable launch seam. `launch` boots one service as a background process
 * and resolves once it is healthy (or the health window elapses); `stopServices`
 * tears a set back down by pid file. Production wires `makeRealLauncher()`; tests
 * pass a fake that records specs and returns canned results.
 */
export interface ServiceLauncher {
  launch(spec: LaunchSpec): Promise<LaunchResult>;
  stopServices(ids: string[]): Promise<StopResult[]>;
}

/**
 * Injectable low-level deps of the REAL launcher, all defaulted to real IO. A
 * unit test overrides these to drive the launcher's logic (already-up, spawn +
 * pid-file, poll-until-healthy, poll-timeout) with NO real process/fs/network.
 */
export interface RealLauncherDeps {
  /** Scratch dir for `<id>.pid` / `<id>.log`. Default `DEFAULT_STATE_DIR`. */
  stateDir?: string;
  /** Health prober (reused HTTP seam). Default `makeRealProber()`. */
  prober?: HealthProber;
  /**
   * Max health-poll attempts (× `pollIntervalMs`). up.sh's `wait_healthy` uses ~40
   * (its services launch from a WARM `dist/`), but the native path runs `pnpm dev`,
   * which does a COLD `tsup` rebuild on start (heavy services can take 30-60s) plus a
   * cold-mesh rabbitmq/redis handshake — so 40s is too tight and a healthy service is
   * spuriously reported down (esp. concurrent slots under load). Default 120; override
   * with `$SAGA_STACK_HEALTH_POLL_ATTEMPTS`.
   */
  pollAttempts?: number;
  /** Delay between health polls in ms (up.sh `sleep 1`). Default 1000. */
  pollIntervalMs?: number;
  /** Spawn a detached background child. Default a `node:child_process.spawn` wrapper. */
  spawn?: SpawnFn;
  /** Sleep helper (overridden in tests to resolve instantly). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** `mkdir -p` the state dir. Default `fs.mkdirSync`. */
  ensureDir?: (dir: string) => void;
  /** Open a write fd for a service's log file. Default `fs.openSync(path,'w')`. */
  openLog?: (path: string) => number | 'ignore';
  /** Persist a pid file. Default `fs.writeFileSync(path, pid+'\n')`. */
  writePid?: (path: string, pid: number) => void;
  /** Read a pid file's contents (for stopServices). Default `fs.readFileSync`; returns null when absent. */
  readPid?: (path: string) => string | null;
  /** Deliver a kill signal. Default `process.kill`. */
  kill?: (pid: number, signal?: NodeJS.Signals) => void;
}

/** The minimal shape the launcher needs from a spawned child. */
export interface ChildLike {
  pid?: number;
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/** A spawn function: launch `command args` in `cwd` with `env`, returning a child handle. */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdout: number | 'ignore' },
) => ChildLike;

/** Path to a service's pid file under the state dir. */
export function pidFilePath(stateDir: string, id: string): string {
  return join(stateDir, `${id}.pid`);
}

/** Path to a service's log file under the state dir. */
export function logFilePath(stateDir: string, id: string): string {
  return join(stateDir, `${id}.log`);
}

/** Read a positive integer from an env var, or undefined if unset/invalid. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The production launcher: spawns each service as a DETACHED background `pnpm
 * dev` (stdout/stderr → `$STATE/<id>.log`), records its pid, and polls the health
 * URL. This is the one place a real service process is launched. Tests inject a
 * fake `ServiceLauncher` via `BaseCommand.getLauncher()`; the deps here are
 * themselves injectable so the launcher's own logic is unit-tested fake-only.
 */
export function makeRealLauncher(deps: RealLauncherDeps = {}): ServiceLauncher {
  const stateDir = deps.stateDir ?? DEFAULT_STATE_DIR;
  const prober = deps.prober ?? makeRealProber();
  const pollAttempts = deps.pollAttempts ?? envInt('SAGA_STACK_HEALTH_POLL_ATTEMPTS') ?? 120;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ensureDir = deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const openLog =
    deps.openLog ??
    ((path: string): number | 'ignore' => {
      try {
        return openSync(path, 'w');
      } catch {
        return 'ignore';
      }
    });
  const writePid =
    deps.writePid ?? ((path: string, pid: number) => writeFileSync(path, `${pid}\n`));
  const readPid =
    deps.readPid ??
    ((path: string): string | null => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    });
  const kill = deps.kill ?? ((pid: number, signal?: NodeJS.Signals) => process.kill(pid, signal));
  const doSpawn: SpawnFn =
    deps.spawn ??
    ((command, args, opts): ChildLike =>
      spawn(command, args, {
        cwd: opts.cwd,
        // Parent env first so the per-service launch env wins (matches up.sh's
        // `env "$@" nohup pnpm dev` — the inline assignments override the shell).
        env: { ...process.env, ...opts.env },
        detached: true,
        stdio: ['ignore', opts.stdout, opts.stdout],
      }) as unknown as ChildLike);

  return {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      // Idempotent re-run: a 200 before we touch anything ⇒ "already up".
      if ((await prober.probe(spec.healthUrl)).ok) {
        return { id: spec.id, ok: true, alreadyUp: true };
      }

      ensureDir(stateDir);
      const stdout = openLog(logFilePath(stateDir, spec.id));

      let child: ChildLike;
      try {
        child = doSpawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdout });
      } catch {
        return { id: spec.id, ok: false };
      }
      // A spawn-level failure (ENOENT etc.) surfaces async — fold into ok:false.
      child.on('error', () => {});
      const pid = child.pid;
      if (typeof pid === 'number') writePid(pidFilePath(stateDir, spec.id), pid);
      // Don't keep the parent event loop alive for the detached child.
      child.unref();

      // wait_healthy: poll up to `pollAttempts`, returning on the first 200.
      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if ((await prober.probe(spec.healthUrl)).ok) {
          return { id: spec.id, ok: true, pid };
        }
        await sleep(pollIntervalMs);
      }
      return { id: spec.id, ok: false, pid };
    },

    async stopServices(ids: string[]): Promise<StopResult[]> {
      const results: StopResult[] = [];
      for (const id of ids) {
        const raw = readPid(pidFilePath(stateDir, id));
        if (raw === null) {
          results.push({ id, stopped: false });
          continue;
        }
        const pid = Number.parseInt(raw.trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) {
          results.push({ id, stopped: false });
          continue;
        }
        try {
          kill(pid);
          results.push({ id, stopped: true, pid });
        } catch {
          // Process already gone / not ours — a clean no-op, not a failure.
          results.push({ id, stopped: false, pid });
        }
      }
      return results;
    },
  };
}

// ── native slot-safe service-stop (M7 Phase 3) ───────────────────────────────
//
// The `ServiceLauncher.stopServices(ids)` method above kills a KNOWN set of
// service ids against a launcher whose `stateDir` was fixed at construction. The
// native slot-safe `down --slot N` needs something stricter and more robust: kill
// EXACTLY the processes the native `up --slot N` recorded — no more, no less —
// WITHOUT a host-global `pkill -f tsup` (which up.sh --down does and which crosses
// every slot). The pid persistence for this ALREADY EXISTS: `makeRealLauncher`'s
// `launch` writes `<stateDir>/<id>.pid` for every service it spawns, and `up`
// threads the slot's `profile.stateDir` (`/tmp/sds-synthetic-s<N>`) into the
// launcher — so slot N's pidfiles live under slot N's state dir and NOWHERE else.
//
// `stopServices(stateDir)` below is therefore a pure ENUMERATION teardown: it reads
// the pidfiles that are actually present under ONE state dir (never a service
// registry, never a process-name match), and SIGTERM→grace→SIGKILL each recorded
// pid. Because the only pids it can ever see are the ones written under the given
// dir, its slot-safety is DIR-SCOPED — a slot-1 teardown physically cannot reach
// slot 0's pidfiles (it never enumerates slot 0's dir). Stale/absent pidfiles
// (process already dead) are tolerated as a clean no-op, and every handled pidfile
// is unlinked so a re-run stays quiet.
//
// KILL THE GROUP, NOT JUST THE LEADER. `makeRealLauncher` spawns each service
// `detached: true` (~:201), which on POSIX makes the child the leader of a NEW
// process group + session (pgid == the recorded pid). The recorded pid is thus the
// group leader of the whole `pnpm dev → tsup --watch → node dist/main.js` subtree,
// and it is the `node dist/main.js` GRANDCHILD that holds the slot's offset port.
// Signalling only the positive leader pid leaves the watcher + port-holder alive
// (up.sh works around this with `pkill -P` + host-global tsup pkill + `fuser -k`,
// ~:1818-1828). So the default signal/liveness deps target the process GROUP via a
// NEGATIVE pid (`process.kill(-pid, sig)` reaches every member), with a positive-pid
// FALLBACK when the group signal throws ESRCH (leader already gone / not a group
// leader). Group-kill does NOT widen the blast radius: it is still keyed on a pid
// recorded under THIS dir, so dir-scoped slot-safety is unchanged. After the
// escalation the process is RE-CHECKED, and a survivor is reported `alive` (not
// `kill`) with its pidfile kept, so `down` never claims a still-running server dead.

/** How one recorded process ended under `stopServices`. */
export type StopOutcome =
  /** Exited after SIGTERM within the grace window. */
  | 'term'
  /** Survived the grace window; a SIGKILL was sent and CONFIRMED it gone. */
  | 'kill'
  /** Signalled with SIGTERM then SIGKILL but STILL alive on the final re-check — under-kill, pidfile kept. */
  | 'alive'
  /** Pidfile present but the process was already gone (or the pid was unparseable). */
  | 'stale';

/** The outcome of stopping ONE recorded service (one pidfile) under a state dir. */
export interface StopServiceResult {
  /** The service id — the pidfile basename with `.pid` stripped. */
  id: string;
  /** The pid read from the file (omitted only when the pidfile was unparseable). */
  pid?: number;
  /** How the process ended. */
  outcome: StopOutcome;
}

/**
 * Injectable low-level deps of the native `stopServices`, all defaulted to real
 * IO. Tests override these to drive the SIGTERM→grace→SIGKILL logic with a fake fs
 * of pidfiles + a fake killer, asserting the signal targets are EXACTLY the given
 * dir's pids and NO real process/fs is touched.
 */
export interface StopServicesDeps {
  /** List filenames under the state dir. Default `fs.readdirSync`; `[]` when the dir is absent. */
  listDir?: (dir: string) => string[];
  /** Read a pid file's contents. Default `fs.readFileSync`; `null` when absent. */
  readPid?: (path: string) => string | null;
  /**
   * True iff the process GROUP led by `pid` is still alive. Default probes the
   * group (`process.kill(-pid, 0)`) with a positive-pid fallback (EPERM ⇒ alive,
   * ESRCH ⇒ dead). Called with the positive recorded pid; the group negation is the
   * default's concern.
   */
  isAlive?: (pid: number) => boolean;
  /**
   * Deliver a signal to a pid. Default a thin `process.kill` wrapper. `stopServices`
   * calls this with a NEGATIVE pid to signal the whole process group, falling back
   * to the positive pid on ESRCH — so a fake can assert the group is the target. May
   * throw ESRCH if already gone.
   */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Remove a handled pidfile. Default `fs.rmSync(path,{force:true})` wrapped so a stray EACCES/EPERM/EISDIR can't reject the whole teardown. */
  removePid?: (path: string) => void;
  /** Sleep between liveness polls (overridden in tests to resolve instantly). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Total grace window (ms) to wait for a graceful SIGTERM exit before SIGKILL. Default 3000. */
  graceMs?: number;
  /** Liveness poll interval (ms) within the grace window. Default 250. */
  pollIntervalMs?: number;
}

/**
 * Default liveness probe. Probes the process GROUP first (`process.kill(-pid, 0)`)
 * so ANY surviving group member (e.g. the port-holding `node dist/main.js`
 * grandchild) reads as alive; on ESRCH (group gone / not a leader) it falls back to
 * the bare-pid probe. EPERM ⇒ alive-but-not-ours, ESRCH ⇒ dead.
 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // group alive but not ours
    if (code === 'ESRCH') {
      // Group gone / pid was never a group leader — degrade to a bare-pid probe.
      try {
        process.kill(pid, 0);
        return true;
      } catch (err2) {
        return (err2 as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    return false;
  }
}

/**
 * Native slot-safe service-stop (M7 Phase 3). Enumerate the `<id>.pid` files under
 * ONE state dir and terminate each recorded process — SIGTERM, then SIGKILL after a
 * grace period if it hasn't exited. ONLY the pids recorded under `stateDir` are ever
 * touched (never a host-global `pkill`), so a slot-N teardown cannot reach another
 * slot's processes. Stale/absent pidfiles (already-dead process, unparseable pid)
 * are tolerated as a clean `stale` no-op. Every handled pidfile is unlinked.
 */
export async function stopServices(
  stateDir: string,
  deps: StopServicesDeps = {},
): Promise<StopServiceResult[]> {
  const listDir =
    deps.listDir ??
    ((dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch {
        return []; // no state dir ⇒ nothing was ever launched here.
      }
    });
  const readPid =
    deps.readPid ??
    ((path: string): string | null => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    });
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const removePid =
    deps.removePid ??
    ((path: string) => {
      // Parity with the other default IO (listDir/readPid/isAlive/kill are all
      // try-wrapped): `rmSync({force:true})` swallows ENOENT but still throws on
      // EACCES/EPERM/EISDIR — a stray permission error must not reject the whole
      // `down`. Best-effort: a pidfile we can't unlink is a cosmetic re-run noise.
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore — teardown already delivered its signals; the file is cosmetic.
      }
    });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = deps.graceMs ?? 3000;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const attempts = Math.max(1, Math.ceil(graceMs / pollIntervalMs));

  // Sorted for a deterministic teardown/report order (fs.readdir order is undefined).
  const pidFiles = listDir(stateDir)
    .filter((f) => f.endsWith('.pid'))
    .sort();

  const results: StopServiceResult[] = [];
  for (const file of pidFiles) {
    const id = file.slice(0, -'.pid'.length);
    const path = join(stateDir, file);

    const raw = readPid(path);
    if (raw === null) continue; // vanished between listing and read — nothing to do.

    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      removePid(path);
      results.push({ id, outcome: 'stale' });
      continue;
    }

    // Signal the process GROUP (negative pid) so the watcher + port-holding
    // grandchild go down with the leader, not just the leader. On ESRCH (the group
    // is gone / the pid was never a group leader) degrade to the bare pid so it
    // still lands. A throw here propagates to the caller's try/catch.
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        kill(-pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          kill(pid, signal); // positive-pid fallback
        } else {
          throw err;
        }
      }
    };

    // Already dead ⇒ clean up the stale pidfile, don't signal anything.
    if (!isAlive(pid)) {
      removePid(path);
      results.push({ id, pid, outcome: 'stale' });
      continue;
    }

    // SIGTERM. An ESRCH between the liveness check and the signal ⇒ it just exited.
    try {
      signalGroup('SIGTERM');
    } catch {
      removePid(path);
      results.push({ id, pid, outcome: 'stale' });
      continue;
    }

    // Poll for a graceful exit within the grace window.
    let exited = false;
    for (let i = 0; i < attempts; i += 1) {
      if (!isAlive(pid)) {
        exited = true;
        break;
      }
      await sleep(pollIntervalMs);
    }
    if (exited) {
      removePid(path);
      results.push({ id, pid, outcome: 'term' });
      continue;
    }

    // Survived the grace window ⇒ SIGKILL the group (best-effort; ESRCH here is fine).
    try {
      signalGroup('SIGKILL');
    } catch {
      // already gone at the wire — the re-check below decides the real outcome.
    }

    // RE-CHECK: SIGKILL is asynchronous, so confirm the group is actually gone
    // before claiming it. If it STILL answers after the grace window, we under-killed
    // — report `alive` and KEEP the pidfile so the leaked server is visible and a
    // re-run retries. Never report a survivor as stopped.
    let killed = false;
    for (let i = 0; i < attempts; i += 1) {
      if (!isAlive(pid)) {
        killed = true;
        break;
      }
      await sleep(pollIntervalMs);
    }
    if (!killed) {
      results.push({ id, pid, outcome: 'alive' });
      continue;
    }
    removePid(path);
    results.push({ id, pid, outcome: 'kill' });
  }
  return results;
}

/** A bound native service-stopper: stop everything recorded under one state dir. */
export type ServiceStopper = (stateDir: string) => Promise<StopServiceResult[]>;
