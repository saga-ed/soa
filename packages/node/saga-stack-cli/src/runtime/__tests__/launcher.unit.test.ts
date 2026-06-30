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
import { makeRealLauncher, pidFilePath } from '../launcher.js';
import type {
  ChildLike,
  LaunchResult,
  LaunchSpec,
  ServiceLauncher,
  SpawnFn,
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
