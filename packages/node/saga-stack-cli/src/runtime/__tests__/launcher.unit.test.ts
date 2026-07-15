/**
 * Native ServiceLauncher seam — contract + real-launcher logic (plan §7.2 M4).
 *
 * The launcher is the seam M4's `stack up --only` tests replace to assert the
 * topo-wave launch order/env WITHOUT spawning. This suite pins (a) the fake
 * contract and (b) `makeRealLauncher`'s OWN logic — already-up short-circuit,
 * spawn+pid-file+poll-until-healthy, poll-timeout, and the stopServices down path
 * — all with injected fakes, so NO real process/fs/network is touched.
 */

import { describe, expect, it, vi } from 'vitest';
import { contractFilePath, makeRealLauncher, pidFilePath, stopServices } from '../launcher.js';

// Mock node:child_process so the DEFAULT SpawnFn's options can be pinned (the
// injectable `deps.spawn` seam sits ABOVE the `detached: true` flag, so only a
// module mock can observe it). Every other test in this file injects its own
// fake spawn, so the mock is inert there.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import type {
  ChildLike,
  LaunchResult,
  LaunchSpec,
  ServiceLauncher,
  SpawnFn,
  StopServicesDeps,
} from '../launcher.js';
import type { HealthProber, ProbeResult } from '../health.js';

const STATE = '/tmp/test-state';

/** A prober that returns canned results in sequence, then repeats the last. */
function seqProber(results: boolean[]): { prober: HealthProber; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const prober: HealthProber = {
    async probe(url: string): Promise<ProbeResult> {
      calls.push(url);
      const ok = results[Math.min(i, results.length - 1)] ?? false;
      i += 1;
      return ok ? { ok: true, status: 200 } : { ok: false };
    },
  };
  return { prober, calls };
}

/** A fake spawn returning a child with a fixed pid; records the call. */
function fakeSpawn(pid: number | undefined): { spawn: SpawnFn; calls: Parameters<SpawnFn>[] } {
  const calls: Parameters<SpawnFn>[] = [];
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push([command, args, opts]);
    const child: ChildLike = { pid, unref: () => {}, on: () => {} };
    return child;
  };
  return { spawn, calls };
}

const SPEC: LaunchSpec = {
  id: 'iam-api',
  cwd: '/repo/iam-api',
  command: 'pnpm',
  args: ['dev'],
  env: { PORT: '3010', AUTH_DEVUSERID: 'beef' },
  healthUrl: 'http://localhost:3010/health',
};

describe('ServiceLauncher contract (fake)', () => {
  it('records each LaunchSpec and returns the canned result', async () => {
    const specs: LaunchSpec[] = [];
    const fake: ServiceLauncher = {
      async launch(spec): Promise<LaunchResult> {
        specs.push(spec);
        return { id: spec.id, ok: true, pid: 999 };
      },
      async stopServices(ids) {
        return ids.map((id) => ({ id, stopped: true }));
      },
    };
    const res = await fake.launch(SPEC);
    expect(res).toEqual({ id: 'iam-api', ok: true, pid: 999 });
    expect(specs[0]).toEqual(SPEC);
  });
});

describe('makeRealLauncher.launch', () => {
  it('short-circuits to alreadyUp when the first probe is healthy (no spawn)', async () => {
    const { prober } = seqProber([true]);
    const { spawn, calls } = fakeSpawn(123);
    const ensureDir = vi.fn();
    const launcher = makeRealLauncher({ stateDir: STATE, prober, spawn, ensureDir });

    const res = await launcher.launch(SPEC);

    expect(res).toEqual({ id: 'iam-api', ok: true, alreadyUp: true });
    expect(calls).toHaveLength(0); // never spawned
    expect(ensureDir).not.toHaveBeenCalled();
  });

  it('spawns detached, writes the pid file, and polls until healthy', async () => {
    // down, down, then up on the 2nd poll.
    const { prober } = seqProber([false, false, true]);
    const { spawn, calls } = fakeSpawn(4242);
    const writePid = vi.fn();
    const openLog = vi.fn(() => 'ignore' as const);
    const ensureDir = vi.fn();
    const sleep = vi.fn(async () => {});
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      spawn,
      writePid,
      openLog,
      ensureDir,
      sleep,
    });

    const res = await launcher.launch(SPEC);

    expect(res).toEqual({ id: 'iam-api', ok: true, pid: 4242 });
    expect(calls).toHaveLength(1);
    const [command, args, opts] = calls[0];
    expect(command).toBe('pnpm');
    expect(args).toEqual(['dev']);
    expect(opts.cwd).toBe('/repo/iam-api');
    expect(opts.env).toEqual({ PORT: '3010', AUTH_DEVUSERID: 'beef' });
    expect(writePid).toHaveBeenCalledWith(pidFilePath(STATE, 'iam-api'), 4242);
    expect(ensureDir).toHaveBeenCalledWith(STATE);
  });

  it('returns ok:false after the poll window elapses', async () => {
    const { prober, calls } = seqProber([false]); // never healthy
    const { spawn } = fakeSpawn(7);
    const sleep = vi.fn(async () => {});
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      spawn,
      pollAttempts: 3,
      sleep,
      writePid: () => {},
      openLog: () => 'ignore',
      ensureDir: () => {},
    });

    const res = await launcher.launch(SPEC);

    expect(res).toEqual({ id: 'iam-api', ok: false, pid: 7 });
    // 1 initial probe + 3 poll probes.
    expect(calls).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('folds a synchronous spawn failure into ok:false', async () => {
    const { prober } = seqProber([false]);
    const spawn: SpawnFn = () => {
      throw new Error('ENOENT');
    };
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      spawn,
      ensureDir: () => {},
      openLog: () => 'ignore',
    });

    const res = await launcher.launch(SPEC);
    expect(res).toEqual({ id: 'iam-api', ok: false });
  });

  it('DEFAULT spawn pins detached:true (own pgid — the group-kill contract, saga-ed/soa#249)', async () => {
    // No `deps.spawn` ⇒ the default node:child_process wrapper runs (mocked above).
    // `detached: true` is LOAD-BEARING: it makes the child a process-group LEADER
    // whose pgid == the recorded pid, which is what lets `stopServices(stateDir)`
    // reap the whole `pnpm dev → tsup --watch → node dist` subtree via kill(-pid).
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ pid: 4242, unref: () => {}, on: () => {} });
    const { prober } = seqProber([false, true]);
    const writePid = vi.fn();
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      writePid,
      openLog: () => 'ignore',
      ensureDir: () => {},
      sleep: async () => {},
    });

    const res = await launcher.launch(SPEC);

    expect(res).toEqual({ id: 'iam-api', ok: true, pid: 4242 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; detached: boolean; stdio: unknown[] },
    ];
    expect(command).toBe('pnpm');
    expect(args).toEqual(['dev']);
    expect(opts.cwd).toBe('/repo/iam-api');
    expect(opts.detached).toBe(true); // ← the pin: revert ⇒ this fails
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'ignore']);
    // Parent env first, per-service launch env wins.
    expect(opts.env.PORT).toBe('3010');
    expect(opts.env.AUTH_DEVUSERID).toBe('beef');
    // The pid recorded IS the group leader's pid (pid == pgid under detached).
    expect(writePid).toHaveBeenCalledWith(pidFilePath(STATE, 'iam-api'), 4242);
  });
});

describe('makeRealLauncher.launch adopt-contract guard (soa#305)', () => {
  // iam-api's spec carries adoptEnv:['JWT_ISSUER'] — the key whose stamp coach-api
  // validates. A stale iam launched by an older CLI (no stamp / a different iss)
  // still 200s on /health but mints a token every consumer 401s; the guard refuses
  // to ADOPT such a process instead of silently serving its drifted contract.
  const GUARDED: LaunchSpec = {
    ...SPEC,
    env: { PORT: '3010', JWT_ISSUER: 'https://iam.wootdev.com' },
    adoptEnv: ['JWT_ISSUER'],
  };
  const FINGERPRINT = JSON.stringify({ JWT_ISSUER: 'https://iam.wootdev.com' });

  it('refuses to adopt an already-up process with NO recorded contract fingerprint', async () => {
    const { prober } = seqProber([true]); // already up
    const { spawn, calls } = fakeSpawn(1);
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      spawn,
      readContract: () => null, // launched by a build that wrote no fingerprint
    });

    const res = await launcher.launch(GUARDED);

    expect(res.ok).toBe(false);
    expect(res.alreadyUp).toBeUndefined(); // NOT adopted
    expect(res.reason).toMatch(/contract/);
    expect(calls).toHaveLength(0); // did not spawn (port is held) — a loud fail
  });

  it('refuses to adopt when the recorded fingerprint DISAGREES (drifted issuer)', async () => {
    const { prober } = seqProber([true]);
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      spawn: fakeSpawn(1).spawn,
      readContract: () => JSON.stringify({ JWT_ISSUER: 'https://iam.saga.org' }),
    });

    const res = await launcher.launch(GUARDED);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('iam.saga.org');
  });

  it('adopts when the recorded fingerprint MATCHES what we would stamp', async () => {
    const { prober } = seqProber([true]);
    const readContract = vi.fn(() => FINGERPRINT);
    const launcher = makeRealLauncher({ stateDir: STATE, prober, readContract });

    const res = await launcher.launch(GUARDED);

    expect(res).toEqual({ id: 'iam-api', ok: true, alreadyUp: true });
    expect(readContract).toHaveBeenCalledWith(contractFilePath(STATE, 'iam-api'));
  });

  it('records the contract fingerprint when it spawns a guarded service', async () => {
    const { prober } = seqProber([false, true]); // not up ⇒ spawn, then healthy
    const writeContract = vi.fn();
    const launcher = makeRealLauncher({
      stateDir: STATE,
      prober,
      spawn: fakeSpawn(4242).spawn,
      writeContract,
      writePid: () => {},
      openLog: () => 'ignore',
      ensureDir: () => {},
      sleep: async () => {},
    });

    await launcher.launch(GUARDED);

    expect(writeContract).toHaveBeenCalledWith(contractFilePath(STATE, 'iam-api'), FINGERPRINT);
  });

  it('leaves an UNguarded service (no adoptEnv) adopted unconditionally', async () => {
    const { prober } = seqProber([true]);
    const readContract = vi.fn(() => null);
    const launcher = makeRealLauncher({ stateDir: STATE, prober, readContract });

    const res = await launcher.launch(SPEC); // no adoptEnv

    expect(res).toEqual({ id: 'iam-api', ok: true, alreadyUp: true });
    expect(readContract).not.toHaveBeenCalled(); // guard never consulted
  });
});

describe('makeRealLauncher.stopServices', () => {
  it('kills the pid from each pid file; clean no-op when absent', async () => {
    const killed: number[] = [];
    const pids: Record<string, string> = {
      [pidFilePath(STATE, 'iam-api')]: '4242\n',
      // sis-api has no pid file
    };
    const launcher = makeRealLauncher({
      stateDir: STATE,
      readPid: (path) => pids[path] ?? null,
      kill: (pid) => killed.push(pid),
    });

    const res = await launcher.stopServices(['iam-api', 'sis-api']);

    expect(res).toEqual([
      { id: 'iam-api', stopped: true, pid: 4242 },
      { id: 'sis-api', stopped: false },
    ]);
    expect(killed).toEqual([4242]);
  });

  it('treats an already-dead process (kill throws) as a clean stop:false', async () => {
    const launcher = makeRealLauncher({
      stateDir: STATE,
      readPid: () => '99\n',
      kill: () => {
        throw new Error('ESRCH');
      },
    });
    const res = await launcher.stopServices(['iam-api']);
    expect(res).toEqual([{ id: 'iam-api', stopped: false, pid: 99 }]);
  });
});

// ── native slot-safe stopServices(stateDir) — M7 Phase 3 ─────────────────────
//
// The pidfile-enumeration teardown that `down --slot N` drives. These pin its
// slot-safety (kills ONLY the given dir's recorded pids) and the SIGTERM→grace→
// SIGKILL escalation, all with a fake fs of pidfiles + a fake killer — no real
// process/fs is touched.

/**
 * A fake fs of pidfiles + a fake process table. `tree` maps a state dir to its
 * `{ serviceId → pid }`. `stubborn` pids survive SIGTERM (need SIGKILL); `unkillable`
 * pids survive even SIGKILL (an under-kill); `dead` pids are already gone before the
 * teardown starts.
 *
 * NB the fake `kill` is invoked with the NEGATIVE (process-group) pid — that is the
 * group-kill contract `stopServices` must honour — so the harness normalises with
 * `Math.abs` against the positive process table. `isAlive` is called with the
 * positive recorded pid (the group negation is the default probe's concern).
 */
function stopHarness(
  tree: Record<string, Record<string, number>>,
  opts: {
    stubborn?: number[];
    unkillable?: number[];
    dead?: number[];
    extraFiles?: Record<string, string[]>;
  } = {},
): { deps: StopServicesDeps; signals: Array<{ pid: number; signal: string }>; removed: string[]; alive: Set<number> } {
  const raw: Record<string, string> = {}; // pidfile path → contents
  const entries: Record<string, string[]> = {}; // dir → filenames
  const alive = new Set<number>();
  for (const [dir, svcs] of Object.entries(tree)) {
    entries[dir] = [...(opts.extraFiles?.[dir] ?? [])];
    for (const [id, pid] of Object.entries(svcs)) {
      entries[dir].push(`${id}.pid`);
      raw[pidFilePath(dir, id)] = `${pid}\n`;
      alive.add(pid);
    }
  }
  for (const d of opts.dead ?? []) alive.delete(d);
  const stubborn = new Set(opts.stubborn ?? []);
  const unkillable = new Set(opts.unkillable ?? []);

  const signals: Array<{ pid: number; signal: string }> = [];
  const removed: string[] = [];
  const deps: StopServicesDeps = {
    listDir: (dir) => entries[dir] ?? [],
    readPid: (path) => (path in raw ? raw[path] : null),
    removePid: (path) => {
      removed.push(path);
      delete raw[path];
    },
    kill: (pid, signal) => {
      signals.push({ pid, signal }); // pid is NEGATIVE — the process group.
      const bare = Math.abs(pid);
      if (signal === 'SIGTERM' && !stubborn.has(bare) && !unkillable.has(bare)) alive.delete(bare);
      if (signal === 'SIGKILL' && !unkillable.has(bare)) alive.delete(bare);
    },
    isAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    graceMs: 100,
    pollIntervalMs: 50, // ⇒ 2 liveness polls per service
  };
  return { deps, signals, removed, alive };
}

const S0 = '/tmp/sds-synthetic';
const S1 = '/tmp/sds-synthetic-s1';

describe('stopServices(stateDir) — native slot-safe teardown', () => {
  it('SIGTERMs the GROUP of EXACTLY the given dir\'s pids and unlinks them — never another slot\'s', async () => {
    const { deps, signals, removed } = stopHarness({
      // slot 0 is live and MUST NOT be touched by a slot-1 teardown.
      [S0]: { 'iam-api': 100, 'sis-api': 101 },
      [S1]: { 'iam-api': 200, 'programs-api': 201 },
    });

    const res = await stopServices(S1, deps);

    // The signal target is the process GROUP (negative pid), reaching the watcher +
    // port-holding grandchild — not just the leader. Only slot 1's groups were
    // signalled; slot 0's (100/101, i.e. -100/-101) never appear.
    expect(signals.map((s) => s.pid).sort((a, b) => a - b)).toEqual([-201, -200]);
    expect(signals.every((s) => s.signal === 'SIGTERM')).toBe(true);
    // Only slot 1's pidfiles were unlinked.
    expect(removed.sort()).toEqual([pidFilePath(S1, 'iam-api'), pidFilePath(S1, 'programs-api')]);
    expect(res).toEqual([
      { id: 'iam-api', pid: 200, outcome: 'term' },
      { id: 'programs-api', pid: 201, outcome: 'term' },
    ]);
  });

  it('escalates to a GROUP SIGKILL when a process outlives the grace window', async () => {
    const { deps, signals } = stopHarness({ [S1]: { 'rtsm-api': 300 } }, { stubborn: [300] });

    const res = await stopServices(S1, deps);

    // Both signals target the group (-300), not the bare leader.
    expect(signals).toEqual([
      { pid: -300, signal: 'SIGTERM' },
      { pid: -300, signal: 'SIGKILL' },
    ]);
    expect(res).toEqual([{ id: 'rtsm-api', pid: 300, outcome: 'kill' }]);
  });

  it('reports `alive` (leak) when a process survives BOTH SIGTERM and SIGKILL — keeps the pidfile', async () => {
    const { deps, signals, removed } = stopHarness(
      { [S1]: { 'rtsm-api': 300 } },
      { unkillable: [300] },
    );

    const res = await stopServices(S1, deps);

    // Escalated all the way and STILL alive on the final re-check ⇒ under-kill.
    expect(signals).toEqual([
      { pid: -300, signal: 'SIGTERM' },
      { pid: -300, signal: 'SIGKILL' },
    ]);
    // The pidfile is KEPT so the leak is visible and a re-run retries.
    expect(removed).toEqual([]);
    expect(res).toEqual([{ id: 'rtsm-api', pid: 300, outcome: 'alive' }]);
  });

  it('falls back to the bare pid when the group signal throws ESRCH (not a group leader)', async () => {
    const targets: number[] = [];
    const deps: StopServicesDeps = {
      listDir: (dir) => (dir === S1 ? ['iam-api.pid'] : []),
      readPid: () => '700\n',
      isAlive: (() => {
        // alive for the initial check, then gone on the first grace poll (the bare-pid
        // fallback SIGTERM landed) ⇒ a graceful `term`, no SIGKILL.
        let calls = 0;
        return () => {
          calls += 1;
          return calls <= 1;
        };
      })(),
      kill: (pid, _signal) => {
        targets.push(pid);
        if (pid < 0) {
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err; // group is gone / pid was never a group leader
        }
        // positive-pid fallback lands
      },
      removePid: () => {},
      sleep: async () => {},
      graceMs: 100,
      pollIntervalMs: 50,
    };

    const res = await stopServices(S1, deps);

    // Tried the group first (-700), then degraded to the bare pid (700).
    expect(targets).toEqual([-700, 700]);
    expect(res).toEqual([{ id: 'iam-api', pid: 700, outcome: 'term' }]);
  });

  it('tolerates a stale pidfile (process already dead) — no signal, unlinks it', async () => {
    const { deps, signals, removed } = stopHarness({ [S1]: { 'iam-api': 400 } }, { dead: [400] });

    const res = await stopServices(S1, deps);

    expect(signals).toEqual([]); // never signalled a dead pid
    expect(removed).toEqual([pidFilePath(S1, 'iam-api')]);
    expect(res).toEqual([{ id: 'iam-api', pid: 400, outcome: 'stale' }]);
  });

  it('tolerates an unparseable pidfile and an absent state dir', async () => {
    const deps: StopServicesDeps = {
      listDir: (dir) => (dir === S1 ? ['iam-api.pid'] : []),
      readPid: () => 'not-a-pid\n',
      kill: () => {
        throw new Error('should not be called');
      },
      isAlive: () => true,
      removePid: () => {},
      sleep: async () => {},
    };

    expect(await stopServices(S1, deps)).toEqual([{ id: 'iam-api', outcome: 'stale' }]);
    // absent dir ⇒ nothing to do.
    expect(await stopServices('/tmp/does-not-exist', deps)).toEqual([]);
  });

  it('ignores non-.pid files under the state dir (logs etc.)', async () => {
    const { deps, signals } = stopHarness(
      { [S1]: { 'iam-api': 500 } },
      { extraFiles: { [S1]: ['iam-api.log', 'notes.txt'] } },
    );

    const res = await stopServices(S1, deps);

    expect(signals).toEqual([{ pid: -500, signal: 'SIGTERM' }]);
    expect(res).toEqual([{ id: 'iam-api', pid: 500, outcome: 'term' }]);
  });
});
