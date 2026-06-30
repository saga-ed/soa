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
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** Max health-poll attempts (up.sh `wait_healthy` ⇒ 40). Default 40. */
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
  const pollAttempts = deps.pollAttempts ?? 40;
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
