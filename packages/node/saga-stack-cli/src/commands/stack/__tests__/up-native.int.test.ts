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
  PgProbe,
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
  // Stateful DB existence: a DB is ABSENT until R2 provision runs its
  // `CREATE DATABASE <name>` psql, after which it EXISTS. This models the real
  // `up --reset` order (provision → reset): every DB probes absent at provision
  // time (so provision CREATEs each), but exists by RESET time (so the R4 reset's
  // existence probe truncates them rather than skipping — the live-run BUG 2).
  // The playback DBs (meshProvisioned:false) are NOT created by R2 provision — their
  // own services create them during launch — so they already EXIST by reset time.
  // Pre-seed them present so the `--with playback --reset` truncate path is exercised
  // (mesh-provisioned DBs are added below when provision runs their CREATE DATABASE).
  const provisioned = new Set<string>(['transcripts_local', 'insights_local', 'chat_local']);
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      const ci = spec.args.indexOf('-c');
      if (ci >= 0) {
        const m = /CREATE DATABASE (\w+)/.exec(spec.args[ci + 1] ?? '');
        if (m) provisioned.add(m[1]);
      }
      return { code: 0 };
    },
  };
  // M8 native prep pass: a fake pg probe so R2 provision + R3 migrate assert their
  // PLAN with NO real docker/postgres. Each DB probes ABSENT (until provision CREATEs
  // it) + table-empty, so provision CREATEs each and migrate takes the `empty →
  // db:deploy` branch (migrate's branch consults hasMigrationsTable/publicTableCount,
  // NOT databaseExists, so the stateful existence doesn't perturb it).
  const pgProbe: PgProbe = {
    async databaseExists(_c, db): Promise<boolean> {
      return provisioned.has(db);
    },
    async hasMigrationsTable(): Promise<boolean> {
      return false;
    },
    async publicTableCount(): Promise<number> {
      return 0;
    },
  };

  const proto = BaseCommand.prototype as unknown as {
    getLauncher: () => ServiceLauncher;
    getMeshExec: () => MeshExec;
    getPortProbe: () => PortProbe;
    getDashFs: () => DashFs;
    getRunner: () => Runner;
    getPgProbe: () => PgProbe;
    getPrepFreshCheck: () => (repoRoot: string) => boolean;
    getRepoDirCheck: () => (dir: string) => boolean;
  };
  vi.spyOn(proto, 'getLauncher').mockReturnValue(launcher);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(meshExec);
  vi.spyOn(proto, 'getPortProbe').mockReturnValue(portProbe);
  vi.spyOn(proto, 'getDashFs').mockReturnValue(dashFs);
  vi.spyOn(proto, 'getRunner').mockReturnValue(runner);
  vi.spyOn(proto, 'getPgProbe').mockReturnValue(pgProbe);
  // Never fresh in these tests (fixed /fixed/dev paths don't exist) ⇒ R1 prep runs.
  vi.spyOn(proto, 'getPrepFreshCheck').mockReturnValue(() => false);
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

  it('--reset natively truncates the closure DBs (no up.sh), then native seed still runs', async () => {
    await StackUp.run(['--only', 'iam-api', '--reset', ...WS], config);
    // M8 R4: `--reset` is NATIVE now — never delegates to up.sh.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    // TRUNCATE ran as docker-exec psql, preserving _prisma_migrations (the DO block).
    const truncs = runs.filter(
      (r) =>
        r.command === 'docker' &&
        r.args.includes('psql') &&
        r.args.includes('-c') &&
        r.args[r.args.indexOf('-c') + 1].includes("tablename <> '_prisma_migrations'"),
    );
    expect(truncs.length).toBeGreaterThan(0);
    // native seed steps still ran (roster baseline).
    expect(runs.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
  });

  it('--with playback --reset threads withPlayback into the native reset (playback DBs truncated)', async () => {
    // BLOCKER 2: the up-path reset must forward `withPlayback` so `--with playback
    // --reset` also truncates the playback trio (transcripts/insights/chat). Without
    // the thread, resetClosure would skip them (meshProvisioned:false) even though
    // --with playback pulled them into the closure — diverging from up.sh --reset
    // --with-playback and from `stack reset --with playback`.
    await StackUp.run(['--with', 'playback', '--reset', ...WS], config);
    const truncatedDbs = runs
      .filter((r) => r.command === 'docker' && r.args.includes('psql') && r.args.includes('-d'))
      .map((r) => r.args[r.args.indexOf('-d') + 1]);
    expect(truncatedDbs).toContain('transcripts_local');
    expect(truncatedDbs).toContain('insights_local');
    expect(truncatedDbs).toContain('chat_local');
  });
});

describe('stack up --slot N — isolated bring-up (M7 Phase 2)', () => {
  // applyInstanceEnv mutates process.env (SAGA_MESH_*_CONTAINER + SNAPSHOTS_DIR);
  // snapshot + restore the affected keys so a slot run can't leak into siblings.
  const SLOT_ENV_KEYS = [
    'SAGA_MESH_POSTGRES_CONTAINER',
    'SAGA_MESH_REDIS_CONTAINER',
    'SAGA_MESH_RABBITMQ_CONTAINER',
    'SAGA_MESH_MONGO_CONTAINER',
    'SAGA_MESH_CONNECT_MONGO_CONTAINER',
    'SAGA_MESH_SNAPSHOTS_DIR',
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of SLOT_ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of SLOT_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('slot > 0 is a backend + saga-dash/coach frontend sub-stack: dash launches on its offset --port; literal-port backends + connect-web dropped', async () => {
    // request the saga-dash frontend + the literal-port playback trio at slot 1:
    // the closure pulls the backend deps; saga-dash now comes up (on its offset
    // port), but every excluded service (literal-port backends + connect-web) is
    // dropped — slot > 0 is a backend + saga-dash/coach frontend sub-stack.
    await StackUp.run(['--only', 'saga-dash', '--with', 'playback', '--slot', '1', ...WS], config);

    const ids = launches.map((s) => s.id);
    // the slot-safe BACKEND deps launched …
    expect(ids).toContain('iam-api');
    expect(ids).toContain('sessions-api');
    expect(ids).toContain('content-api');
    // … and saga-dash is now IN the slot, listening on its offset port via `--port`.
    expect(ids).toContain('saga-dash');
    const dash = launches.find((s) => s.id === 'saga-dash');
    expect(dash?.command).toBe('pnpm');
    expect(dash?.args).toEqual(['dev', '--port', '9900']); // 8900 + slot 1 offset
    // … but the still-un-slottable services are dropped from the slot bring-up:
    // connect-web (depends on the un-tokenized connect-api) …
    expect(ids).not.toContain('connect-web');
    // … and the literal-port backends (bypass the offset).
    expect(ids).not.toContain('ads-adm-api');
    expect(ids).not.toContain('connect-api');
    expect(ids).not.toContain('transcripts-api');
    expect(ids).not.toContain('insights-api');
    expect(ids).not.toContain('chat-api');

    // mesh came up under the slot project on offset ports.
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.args).toContain('COMPOSE_PROJECT_NAME=soa-s1');
    expect(makeUp?.args).toContain('POSTGRES_PORT=6432');
    expect(makeUp?.env).toMatchObject({ COMPOSE_PROJECT_NAME: 'soa-s1' });
    // readiness gated the slot's containers (env seam applied).
    expect(meshGated.every((c) => c.startsWith('soa-s1-'))).toBe(true);

    // env seam set for the snapshot store + container resolvers.
    expect(process.env.SAGA_MESH_POSTGRES_CONTAINER).toBe('soa-s1-postgres-1');
    expect(process.env.SAGA_MESH_SNAPSHOTS_DIR?.endsWith('/.saga-mesh/snapshots-s1')).toBe(true);
  });

  it('slot > 0 launches saga-dash on its offset --port and WRITES the slot dash config', async () => {
    // saga-dash listens on its offset port now (launch-seam `--port 9900`), so it is
    // included at slot > 0. Its prelaunch hook fires and WRITES config.local.json
    // pointing each dash service at its offset localhost port (not slot 0's).
    await StackUp.run(['--only', 'saga-dash', '--slot', '1', ...WS], config);
    expect(launches.map((s) => s.id)).toContain('saga-dash');
    const dash = launches.find((s) => s.id === 'saga-dash');
    expect(dash?.args).toEqual(['dev', '--port', '9900']); // 8900 + slot 1 offset
    expect(launches.map((s) => s.id)).toContain('iam-api'); // backend dep up too
    // dash prelaunch hook ran and WROTE the offset-port slot config (not removed).
    expect(dashCalls.some((c) => c.startsWith('write:'))).toBe(true);
  });

  it('BARE full-stack --slot 1 routes through the NATIVE path (never the up.sh wrapper)', async () => {
    // BLOCKER-1: a bare `up --slot 1` (no --only) must NOT fall through to up.sh
    // (hardcoded project soa / base ports / slot-0 STATE → clobbers slot 0). It is
    // expanded to the full non-optional set and brought up natively as a soa-s1
    // BACKEND sub-stack.
    await StackUp.run(['--slot', '1', ...WS], config);

    // never resolved/ran the up.sh wrapper.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    // launched natively — the backend set + saga-dash/coach frontends present, the
    // still-un-slottable services (literal-port backends + connect) are not.
    const ids = launches.map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('iam-api');
    expect(ids).toContain('sessions-api');
    expect(ids).toContain('saga-dash'); // frontend now slottable via --port
    expect(ids).toContain('coach-web');
    expect(ids).not.toContain('connect-api');
    expect(ids).not.toContain('connect-web');
    expect(ids).not.toContain('ads-adm-api');

    // mesh came up under the slot project on offset ports (soa-s1, +1000).
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.args).toContain('COMPOSE_PROJECT_NAME=soa-s1');
    expect(makeUp?.args).toContain('POSTGRES_PORT=6432');
    expect(makeUp?.env).toMatchObject({ COMPOSE_PROJECT_NAME: 'soa-s1' });
  });

  it('BARE full-stack at slot 0 keeps the up.sh wrapper (byte-identical)', async () => {
    // The slot-0 wrapper path is covered in wrappers.int.test.ts (it mocks getRunner
    // only); here we just prove a bare slot-0 run does NOT take the native path — no
    // native service launches happen (it delegates entirely to up.sh via the Runner).
    await StackUp.run([...WS], config);
    expect(launches).toEqual([]);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(true);
  });

  it('--slot 10 is rejected at the flag layer (rabbitmq-mgmt collision ceiling)', async () => {
    await expect(StackUp.run(['--slot', '10', ...WS], config)).rejects.toThrow(
      /9|less than or equal|cannot be greater/i,
    );
    expect(launches).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('slot 0 launches ads-adm-api and REMOVES the dash config (byte-identical)', async () => {
    await StackUp.run(['--only', 'saga-dash', ...WS], config);
    expect(launches.map((s) => s.id)).toContain('ads-adm-api');
    expect(meshGated.every((c) => !c.startsWith('soa-s1-'))).toBe(true);
    // dash existsFile()=false in the fake ⇒ non-tunnel slot-0 path is a noop-absent
    // (no write). The key assertion: NO stack-slot write happened at slot 0.
    expect(dashCalls.some((c) => c.startsWith('write:'))).toBe(false);
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
