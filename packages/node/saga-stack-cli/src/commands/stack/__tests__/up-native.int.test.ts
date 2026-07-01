/**
 * `stack up --only` NATIVE partial-stack integration tests (plan §6.3, §7.2 "M4").
 *
 * M4's headline payoff: `stack up --only <svc,…>` (without --dry-run) boots ONLY
 * the computed dependency closure FOR REAL — natively, NOT by shelling out to
 * up.sh. These tests drive the REAL StackUp command end-to-end (parse argv →
 * computeClosure → makeStackApi → up()+seed()) but REPLACE every IO seam on the
 * BaseCommand prototype with a fake: `getLauncher` / `getMeshExec` / `getPortProbe`
 * / `getDashFs` / `getRunner`. NOTHING is spawned: no pnpm dev, no make, no docker.
 *
 * The native path takes over `--only` entirely; the up.sh-wrapper fallback (single
 * service + a native-unsupported flag) and the full-stack wrapper live in
 * wrappers.int.test.ts (which only mocks getRunner).
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type {
  LaunchResult,
  LaunchSpec,
  MeshExec,
  PortProbe,
  RunResult,
  Runner,
  ScriptInvocation,
  ServiceLauncher,
  StopResult,
  DashFs,
} from '../../../runtime/index.js';
import StackUp from '../up.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
let meshGated: string[];
let dashCalls: string[];

/** Install fakes for ALL native-path seams. `launchFail` ids answer health-down. */
function installNativeSeams(launchFail: Set<string> = new Set()): void {
  launches = [];
  runs = [];
  meshGated = [];
  dashCalls = [];

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      launches.push(spec);
      return { id: spec.id, ok: !launchFail.has(spec.id), pid: 2000 + launches.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true }));
    },
  };
  const meshExec: MeshExec = {
    async ready(container: string): Promise<boolean> {
      meshGated.push(container);
      return true;
    },
  };
  const portProbe: PortProbe = {
    async dockerHolder(): Promise<string | null> {
      return null;
    },
    async listening(): Promise<boolean> {
      return false;
    },
  };
  const dashFs: DashFs = {
    existsDir: (p: string) => {
      dashCalls.push(`existsDir:${p}`);
      return true;
    },
    existsFile: () => false,
    remove: (p: string) => dashCalls.push(`remove:${p}`),
    write: (p: string) => dashCalls.push(`write:${p}`),
  };
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      return { code: 0 };
    },
  };

  const proto = BaseCommand.prototype as unknown as {
    getLauncher: () => ServiceLauncher;
    getMeshExec: () => MeshExec;
    getPortProbe: () => PortProbe;
    getDashFs: () => DashFs;
    getRunner: () => Runner;
    getRepoDirCheck: () => (dir: string) => boolean;
  };
  vi.spyOn(proto, 'getLauncher').mockReturnValue(launcher);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(meshExec);
  vi.spyOn(proto, 'getPortProbe').mockReturnValue(portProbe);
  vi.spyOn(proto, 'getDashFs').mockReturnValue(dashFs);
  vi.spyOn(proto, 'getRunner').mockReturnValue(runner);
  // The fake workspace paths (--dev /fixed/dev) don't exist on disk; default the
  // repo-dir check to "present" so services aren't skipped. The skip-when-absent
  // path is covered explicitly in stack-api.int.test.ts.
  vi.spyOn(proto, 'getRepoDirCheck').mockReturnValue(() => true);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installNativeSeams();
  // silence the command's emit()/log lines in the test output.
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack up --only — native partial-stack', () => {
  it('boots the closure natively: mesh make-up, topo-wave launch, native seed (no up.sh)', async () => {
    await StackUp.run(['--only', 'scheduling-api,sessions-api', ...WS], config);

    // launched the full closure in topo order — NOT via up.sh.
    expect(launches.map((s) => s.id)).toEqual([
      'iam-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
    ]);
    // each launch is `pnpm dev` with resolved env.
    expect(launches[0].command).toBe('pnpm');
    expect(launches[0].args).toEqual(['dev']);

    // mesh: make up ran in <soa>/infra; only postgres+rabbitmq gated (no mongo).
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.cwd).toBe(resolve(SOA_ROOT, 'infra'));
    expect(meshGated).toEqual(['soa-postgres-1', 'soa-rabbitmq-1']);

    // native seed: roster offline steps ran through the Runner (no up.sh argv).
    const seedRuns = runs.filter((r) => r.command !== 'make');
    expect(seedRuns.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
    expect(seedRuns.some((r) => r.args.includes('db:seed'))).toBe(true);
    // never resolved/ran up.sh.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });

  it('runs the dash prelaunch hook when saga-dash is in the closure', async () => {
    await StackUp.run(['--only', 'saga-dash', ...WS], config);
    expect(launches.some((s) => s.id === 'saga-dash')).toBe(true);
    expect(dashCalls.some((c) => c.startsWith('existsDir:'))).toBe(true);
  });

  it('exits non-zero when a service never becomes healthy (and stops launching the rest)', async () => {
    installNativeSeams(new Set(['iam-api']));
    await expect(
      StackUp.run(['--only', 'scheduling-api', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 1 } });
    // iam-api is the first wave; dependents never launched.
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);
  });

  it('--login delegates to up.sh after the native bring-up + seed', async () => {
    await StackUp.run(['--only', 'iam-api', '--login', ...WS], config);
    // native launch + seed happened …
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);
    // … and up.sh was invoked ONLY for the delegated --login.
    const upSh = runs.filter((r) => r.command.endsWith('up.sh'));
    expect(upSh).toHaveLength(1);
    // flagMap.login() is a flag-only invocation (no leading `up` verb).
    expect(upSh[0].args).toEqual(['--login']);
  });

  it('coach absent + --seed full: coach-pg is NOT planned and the run does not fail', async () => {
    // Report the coach checkout as absent; every other repo present.
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue((dir: string) => !dir.endsWith('/coach'));

    // closure(coach-web) = coach-web + coach-api (COACH, absent) + iam-api (present).
    await expect(
      StackUp.run(['--only', 'coach-web', '--seed', 'full', ...WS], config),
    ).resolves.toBeUndefined();

    // only iam-api launched; the coach pair was skipped (repo not cloned).
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);

    // the seed plan dropped coach-pg — NOTHING ran against the coach-db dir (which
    // would have spawn-crashed on the missing checkout with a real runner).
    expect(runs.some((r) => r.cwd.includes('/coach'))).toBe(false);
    expect(runs.some((r) => r.command === 'pnpm' && r.args.includes('db:seed') && r.cwd.includes('coach-db'))).toBe(
      false,
    );
  });

  it('accepts the --coach repo-override flag (native path, no "Nonexistent flag")', async () => {
    // The per-repo --coach pin must parse; it just pins the COACH checkout path.
    await StackUp.run(['--only', 'iam-api', '--coach', '/some/dir', ...WS], config);
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);
  });

  it('--reset delegates `up.sh --reset` after bring-up, then native seed still runs', async () => {
    await StackUp.run(['--only', 'iam-api', '--reset', ...WS], config);
    const upSh = runs.filter((r) => r.command.endsWith('up.sh'));
    expect(upSh).toHaveLength(1);
    // flagMap.reset() is a flag-only invocation (no leading `up` verb).
    expect(upSh[0].args).toEqual(['--reset']);
    // native seed steps still ran (roster baseline).
    expect(runs.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
  });
});

describe('stack up --only --dry-run — planner prints the native launch + seed plan', () => {
  it('does NOT touch any seam and emits the seed plan', async () => {
    const logged: string[] = [];
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
      logged.push(String(m ?? ''));
    });
    await StackUp.run(['--only', 'scheduling-api,sessions-api', '--dry-run', ...WS], config);

    expect(launches).toEqual([]);
    expect(runs).toEqual([]);
    const text = logged.join('\n');
    expect(text).toContain('native partial-stack: would launch');
    expect(text).toContain('offline:');
  });
});
