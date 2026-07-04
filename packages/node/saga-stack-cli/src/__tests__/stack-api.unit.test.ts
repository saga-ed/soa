/**
 * StackApi facade unit tests (plan §6.3).
 *
 * Drive `makeStackApi(manifest, runtime)` with FAKE seams (launcher / meshExec /
 * portProbe / dashFs / prober / runner / delegate) — NO real process, docker,
 * fetch, or fs. Assert the facade's sequencing:
 *   up()    — meshUp (preflight → make up → readiness) → dash hook (only when
 *             saga-dash is in the closure) → topo-WAVE service launch, deps first.
 *   seed()  — offline then online steps via the Runner; fatal aborts, warn continues.
 *   verify()— probe each URL; tolerate by id or repo.
 *   down()  — stopServices in reverse launch order.
 *   reset()/login() — delegated to up.sh via the `delegate` seam (M4).
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../core/closure.js';
import { deriveInstance } from '../core/derive-instance.js';
import { defaultLaunchContext } from '../core/launch-plan.js';
import type { LaunchContext } from '../core/launch-plan.js';
import { manifest } from '../core/manifest/index.js';
import type { RepoKey, ServiceId } from '../core/manifest/index.js';
import { healthProbes } from '../core/probe-plan.js';
import { composeSeedPlan } from '../core/seed/compose-seed-plan.js';
import { makeStackApi } from '../stack-api.js';
import type { Runtime } from '../stack-api.js';
import type {
  DashFs,
  HealthProber,
  LaunchResult,
  LaunchSpec,
  MeshExec,
  PortProbe,
  RunResult,
  Runner,
  ScriptInvocation,
  ServiceLauncher,
  StopResult,
} from '../runtime/index.js';

// ── fakes ──────────────────────────────────────────────────────────────────

const REPO_ROOTS = {
  SOA: '/dev/soa',
  ROSTERING: '/dev/rostering',
  PROGRAM_HUB: '/dev/program-hub',
  SAGA_DASH: '/dev/saga-dash',
  SDS: '/dev/student-data-system',
  QBOARD: '/dev/qboard',
  RTSM: '/dev/rtsm',
  FLEEK: '/dev/fleek',
  COACH: '/dev/coach',
} as Record<RepoKey, string>;

function ctx(): LaunchContext {
  return defaultLaunchContext({ repoRoots: REPO_ROOTS, syntheticDevDir: '/dev/soa/tools/synthetic-dev' });
}

interface Fakes {
  launches: LaunchSpec[];
  stopped: string[];
  runs: ScriptInvocation[];
  meshExecs: { container: string; cmd: string }[];
  dashCalls: string[];
  delegated: ScriptInvocation[];
}

function makeRuntime(overrides: Partial<Runtime> = {}): { runtime: Runtime; fakes: Fakes } {
  const fakes: Fakes = { launches: [], stopped: [], runs: [], meshExecs: [], dashCalls: [], delegated: [] };

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      fakes.launches.push(spec);
      return { id: spec.id, ok: true, pid: 1000 + fakes.launches.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      fakes.stopped.push(...ids);
      return ids.map((id) => ({ id, stopped: true, pid: 1 }));
    },
  };
  const meshExec: MeshExec = {
    async ready(container: string, readinessCmd: string): Promise<boolean> {
      fakes.meshExecs.push({ container, cmd: readinessCmd });
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
      fakes.dashCalls.push(`existsDir:${p}`);
      return true;
    },
    existsFile: () => false,
    remove: (p: string) => fakes.dashCalls.push(`remove:${p}`),
    write: (p: string) => fakes.dashCalls.push(`write:${p}`),
  };
  const prober: HealthProber = {
    async probe(url: string) {
      // content-api runs on :3009 — mark it down so the verify/tolerate test bites.
      return url.includes(':3009') ? { ok: false } : { ok: true, status: 200 };
    },
  };
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      fakes.runs.push(spec);
      return { code: 0 };
    },
  };

  const runtime: Runtime = {
    lane: 'stack',
    launchContext: ctx(),
    soaRoot: REPO_ROOTS.SOA,
    sagaDashRoot: REPO_ROOTS.SAGA_DASH,
    launcher,
    meshExec,
    portProbe,
    dashFs,
    prober,
    runner,
    delegate: async (plan) => {
      fakes.delegated.push({ cwd: '', command: 'up.sh', args: plan.args, env: plan.env });
      return 0;
    },
    ...overrides,
  };
  return { runtime, fakes };
}

// ── up() ─────────────────────────────────────────────────────────────────────

describe('StackApi.up — native partial-stack bring-up', () => {
  it('mesh + topo-wave launch: deps before dependents, no dash hook when saga-dash absent', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['scheduling-api', 'sessions-api'] as ServiceId[]);

    const res = await api.up(closure.services);

    expect(res.ok).toBe(true);
    // launch order is the topo flatten: iam-api → programs-api → scheduling-api → sessions-api.
    expect(fakes.launches.map((s) => s.id)).toEqual([
      'iam-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
    ]);
    // command split from `pnpm dev`.
    expect(fakes.launches[0].command).toBe('pnpm');
    expect(fakes.launches[0].args).toEqual(['dev']);
    // saga-dash not in the closure ⇒ the dash prelaunch hook never touched the fs.
    expect(fakes.dashCalls).toEqual([]);
    // mesh: only the closure's units (postgres + redis via iam-api + rabbitmq) were readiness-gated.
    expect(res.mesh.units.map((u) => u.id)).toEqual(['postgres', 'redis', 'rabbitmq']);
    // `make up` ran in <soa>/infra.
    const makeUp = fakes.runs.find((r) => r.command === 'make');
    expect(makeUp?.cwd).toBe('/dev/soa/infra');
  });

  it('launch env is FAITHFUL + fully resolved (no dangling tokens)', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['scheduling-api'] as ServiceId[]);
    await api.up(closure.services);

    const sched = fakes.launches.find((s) => s.id === 'scheduling-api');
    expect(sched).toBeDefined();
    // tokens resolved: DATABASE_URL ← SCHEDULING_DB_URL, RABBITMQ_URL ← MESH_MQ, CORS_ORIGIN ← DASH_URL.
    expect(sched?.env.DATABASE_URL).toBe('postgresql://saga_user:password123@localhost:5432/scheduling');
    expect(sched?.env.RABBITMQ_URL).toBe('amqp://rabbitmq_admin:password123@localhost:5672');
    expect(sched?.env.CORS_ORIGIN).toBe('http://localhost:8900');
    // No env value still carries a ${TOKEN}.
    for (const spec of fakes.launches) {
      for (const v of Object.values(spec.env)) expect(v).not.toMatch(/\$\{/);
    }
    // health URL built from the resolved stack-lane port.
    expect(sched?.healthUrl).toBe('http://localhost:3008/health');
  });

  it('runs the dash prelaunch hook when saga-dash is in the closure', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['saga-dash'] as ServiceId[]);
    const res = await api.up(closure.services);

    expect(res.dash?.action).toBe('noop-absent'); // existsFile:false, non-tunnel ⇒ nothing to remove
    expect(fakes.dashCalls.some((c) => c.startsWith('existsDir:'))).toBe(true);
    expect(fakes.launches.some((s) => s.id === 'saga-dash')).toBe(true);
  });

  it('slot 0: a frontend launch command is byte-identical (no --port appended)', async () => {
    const { runtime, fakes } = makeRuntime(); // default slot (undefined ⇒ 0)
    const api = makeStackApi(manifest, runtime);
    await api.up(['saga-dash'] as ServiceId[]);

    const dash = fakes.launches.find((s) => s.id === 'saga-dash');
    expect(dash?.command).toBe('pnpm');
    expect(dash?.args).toEqual(['dev']); // no --port append at slot 0
  });

  it('slot > 0: appends `--port <base+offset>` to a frontend so it binds its offset port', async () => {
    // Build a slot-1 launch context (offset ports) exactly as the up command does.
    const profile = deriveInstance({ slot: 1 });
    const slotCtx = defaultLaunchContext({
      repoRoots: REPO_ROOTS,
      syntheticDevDir: '/dev/soa/tools/synthetic-dev',
      portOverrides: profile.portOverrides,
      meshOffset: profile.meshOffset,
    });
    const { runtime, fakes } = makeRuntime({ launchContext: slotCtx, slot: 1 });
    const api = makeStackApi(manifest, runtime);
    await api.up(['saga-dash', 'coach-web'] as ServiceId[]);

    // saga-dash 8900 + 1000 offset ⇒ appended `--port 9900`; vite honours the last --port.
    const dash = fakes.launches.find((s) => s.id === 'saga-dash');
    expect(dash?.command).toBe('pnpm');
    expect(dash?.args).toEqual(['dev', '--port', '9900']);
    // coach-web 8800 + 1000 ⇒ `--port 9800` (general over isFrontend, not per-service).
    const coach = fakes.launches.find((s) => s.id === 'coach-web');
    expect(coach?.args).toEqual(['dev', '--port', '9800']);
    // coach-web's outbound dep URL offsets too: PUBLIC_COACH_API_URL ← offset coach-api.
    expect(coach?.env.PUBLIC_COACH_API_URL).toBe('http://localhost:7105'); // 6105 + 1000
  });

  it('aborts (ok:false) and stops launching when a wave service never goes healthy', async () => {
    const { runtime, fakes } = makeRuntime({
      launcher: {
        async launch(spec: LaunchSpec): Promise<LaunchResult> {
          fakes.launches.push(spec);
          return { id: spec.id, ok: spec.id !== 'iam-api' }; // iam-api fails health
        },
        async stopServices(): Promise<StopResult[]> {
          return [];
        },
      },
    });
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['scheduling-api'] as ServiceId[]);
    const res = await api.up(closure.services);

    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('iam-api');
    // iam-api is wave 1; dependents are never launched after the wave fails.
    expect(fakes.launches.map((s) => s.id)).toEqual(['iam-api']);
  });

  it('aborts before launch when the mesh preflight finds a port conflict', async () => {
    const { runtime, fakes } = makeRuntime({
      portProbe: {
        async dockerHolder(port: number): Promise<string | null> {
          return port === 5432 ? 'rogue-postgres' : null;
        },
        async listening(): Promise<boolean> {
          return false;
        },
      },
    });
    const api = makeStackApi(manifest, runtime);
    const res = await api.up(computeClosure(manifest, ['iam-api'] as ServiceId[]).services);

    expect(res.ok).toBe(false);
    expect(res.mesh.conflicts.map((c) => c.port)).toContain(5432);
    expect(fakes.launches).toEqual([]); // never reached the launch stage
    expect(fakes.runs.some((r) => r.command === 'make')).toBe(false); // never ran make up
  });
});

// ── native prep pass wiring (M8 — R1 build → R2 provision → R3 migrate) ──────

import type { PgProbe } from '../runtime/index.js';

/** A pg probe: DBs absent + table-empty by default (fresh volume). */
function fakePgProbe(
  opts: { exists?: Record<string, boolean>; branch?: Record<string, 'managed' | 'empty' | 'unmanaged'> } = {},
): PgProbe {
  return {
    async databaseExists(_c, db): Promise<boolean> {
      return opts.exists?.[db] ?? false;
    },
    async hasMigrationsTable(_c, db): Promise<boolean> {
      return (opts.branch?.[db] ?? 'empty') === 'managed';
    },
    async publicTableCount(_c, db): Promise<number> {
      return (opts.branch?.[db] ?? 'empty') === 'unmanaged' ? 3 : 0;
    },
  };
}

describe('StackApi.up — native prep pass wiring (M8)', () => {
  it('runs R1 build → R2 provision → R3 migrate between mesh-up and launch, in order', async () => {
    const { runtime, fakes } = makeRuntime({ pgProbe: fakePgProbe(), prepIsFresh: () => false });
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['scheduling-api'] as ServiceId[]);

    const res = await api.up(closure.services);
    expect(res.ok).toBe(true);

    // all three phases populated + ok.
    expect(res.prep?.ok).toBe(true);
    expect(res.provision?.ok).toBe(true);
    expect(res.migrate?.ok).toBe(true);

    // R1 prepped the closure repos (rostering + program-hub).
    expect(new Set(res.prep?.steps.map((s) => s.repo))).toEqual(new Set(['ROSTERING', 'PROGRAM_HUB']));
    // R2 created the closure DBs (fresh volume: all absent). closure(scheduling-api)
    // = {iam-api, scheduling-api} ⇒ iam_local, iam_pii_local, scheduling.
    expect(res.provision?.dbs.filter((d) => d.action === 'created').map((d) => d.db)).toEqual([
      'iam_local',
      'iam_pii_local',
      'scheduling',
    ]);
    // R3 migrated in canonical order: iam FIXED steps, then the db:deploy target.
    expect(res.migrate?.dbs.map((d) => `${d.db}:${d.branch}`)).toEqual([
      'iam_local:fixed',
      'iam_pii_local:fixed',
      'scheduling:empty',
    ]);

    // ORDER in the runner call log: make up → prep (pnpm install) → provision
    // (docker exec) → migrate (pnpm db:deploy). Launch is via the launcher seam.
    const makeIdx = fakes.runs.findIndex((r) => r.command === 'make');
    const prepIdx = fakes.runs.findIndex((r) => r.command === 'pnpm' && r.args.includes('install'));
    const provIdx = fakes.runs.findIndex((r) => r.command === 'docker');
    const migIdx = fakes.runs.findIndex((r) => r.command === 'pnpm' && r.args.includes('db:deploy'));
    expect(makeIdx).toBeGreaterThanOrEqual(0);
    expect(makeIdx).toBeLessThan(prepIdx);
    expect(prepIdx).toBeLessThan(provIdx);
    expect(provIdx).toBeLessThan(migIdx);
  });

  it('is SKIPPED entirely when no pgProbe is wired (pre-M8 byte-identical path)', async () => {
    const { runtime } = makeRuntime(); // no pgProbe
    const api = makeStackApi(manifest, runtime);
    const res = await api.up(computeClosure(manifest, ['iam-api'] as ServiceId[]).services);
    expect(res.prep).toBeUndefined();
    expect(res.provision).toBeUndefined();
    expect(res.migrate).toBeUndefined();
  });

  it('idempotent re-up is a fast no-op: fresh repos skipped, DBs exist, migrate stays non-destructive', async () => {
    const { runtime, fakes } = makeRuntime({
      prepIsFresh: () => true, // already built
      pgProbe: fakePgProbe({
        exists: { iam_local: true, iam_pii_local: true, programs: true, scheduling: true },
        branch: { programs: 'managed', scheduling: 'managed' },
      }),
    });
    const api = makeStackApi(manifest, runtime);
    const res = await api.up(computeClosure(manifest, ['scheduling-api'] as ServiceId[]).services);

    expect(res.ok).toBe(true);
    // R1: every repo fresh ⇒ no prep steps ran.
    expect(res.prep?.steps).toEqual([]);
    // R2: every DB exists ⇒ ZERO docker-exec CREATE statements.
    expect(fakes.runs.some((r) => r.command === 'docker')).toBe(false);
    expect(res.provision?.dbs.every((d) => d.action === 'exists' || d.action === 'skipped')).toBe(true);
    // R3: db:deploy targets are `managed` (apply-pending) — never the destructive reset.
    expect(fakes.runs.some((r) => r.args.includes('reset'))).toBe(false);
  });

  it('aborts the bring-up (ok:false) + never launches when R2 provisioning fails', async () => {
    const { runtime, fakes } = makeRuntime({
      pgProbe: fakePgProbe(),
      prepIsFresh: () => true, // skip prep to isolate the provision failure
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          fakes.runs.push(spec);
          return { code: spec.command === 'docker' ? 1 : 0 }; // provision psql fails
        },
      },
    });
    const api = makeStackApi(manifest, runtime);
    const res = await api.up(computeClosure(manifest, ['iam-api'] as ServiceId[]).services);
    expect(res.ok).toBe(false);
    expect(res.provision?.ok).toBe(false);
    expect(fakes.launches).toEqual([]); // never reached the launch stage
  });

  it('slot > 0: provision + migrate target the slot pg container and offset DB URL', async () => {
    const { runtime, fakes } = makeRuntime({
      pgProbe: fakePgProbe(),
      prepIsFresh: () => true,
      pgContainer: 'soa-s1-postgres-1',
      meshOffset: 1000,
    });
    const api = makeStackApi(manifest, runtime);
    await api.up(computeClosure(manifest, ['programs-api'] as ServiceId[]).services);

    // provision docker-exec hit the slot container.
    const dockerCall = fakes.runs.find((r) => r.command === 'docker');
    expect(dockerCall?.args[1]).toBe('soa-s1-postgres-1');
    // migrate DATABASE_URL points at the slot's offset mesh port.
    const migCall = fakes.runs.find((r) => r.command === 'pnpm' && r.args.includes('db:deploy'));
    expect(migCall?.env.DATABASE_URL).toBe('postgresql://saga_user:password123@localhost:6432/programs');
  });
});

// ── seed() ─────────────────────────────────────────────────────────────────

describe('StackApi.seed — offline then online via the Runner', () => {
  it('runs the roster offline steps in order, none online, resolved cwds', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'roster' },
      new Set<ServiceId>(['iam-api', 'programs-api', 'scheduling-api', 'sessions-api']),
      new Set<ServiceId>(),
    );
    const res = await api.seed(plan);

    expect(res.ok).toBe(true);
    expect(res.ran.offline).toEqual(['iam-dev-user', 'iam', 'sessions']);
    expect(res.ran.online).toEqual([]);
    // iam steps run under the iam-db package in PROGRAM_HUB? No — iam-api repo. Assert cwd is resolved (absolute).
    const iamRun = fakes.runs.find((r) => r.args.includes('db:seed') && r.cwd.includes('iam-db'));
    expect(iamRun?.cwd.startsWith('/dev/')).toBe(true);
  });

  it('a FATAL non-zero step aborts the run; a WARN step continues', async () => {
    // Runner fails the `iam` db:seed (fatal) ⇒ run aborts at it.
    const { runtime } = makeRuntime({
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          const isIamSeed = spec.cwd.includes('iam-db') && spec.args.includes('db:seed');
          return { code: isIamSeed ? 1 : 0 };
        },
      },
    });
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'roster' },
      new Set<ServiceId>(['iam-api', 'sessions-api']),
      new Set<ServiceId>(),
    );
    const res = await api.seed(plan);

    expect(res.ok).toBe(false);
    expect(res.failed).toBe('iam');
    expect(res.ran.offline).toEqual(['iam-dev-user']); // ran before the fatal step
  });

  it('a WARN step whose runner THROWS (ENOENT) degrades to a warning, not an unhandled rejection', async () => {
    // The warn-mode dev-user bootstrap spawn-throws (its repo/cwd is missing);
    // seed must swallow it, record the step, and keep going — never reject.
    const { runtime } = makeRuntime({
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          if (spec.args.includes('seed-dev-user.js')) {
            throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
          }
          return { code: 0 };
        },
      },
    });
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'roster' },
      new Set<ServiceId>(['iam-api', 'sessions-api']),
      new Set<ServiceId>(),
    );

    const res = await api.seed(plan); // must resolve, not throw
    expect(res.ok).toBe(true);
    // the throwing warn step is still recorded, and the run continued past it.
    expect(res.ran.offline).toEqual(['iam-dev-user', 'iam', 'sessions']);
  });

  it('a FATAL step whose runner THROWS (ENOENT) aborts the run (ok:false)', async () => {
    const { runtime } = makeRuntime({
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          // `iam` (fatal) db:seed spawn-throws.
          if (spec.cwd.includes('iam-db') && spec.args.includes('db:seed')) {
            throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
          }
          return { code: 0 };
        },
      },
    });
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'roster' },
      new Set<ServiceId>(['iam-api', 'sessions-api']),
      new Set<ServiceId>(),
    );

    const res = await api.seed(plan); // resolves with ok:false (no unhandled rejection)
    expect(res.ok).toBe(false);
    expect(res.failed).toBe('iam');
  });

  it('online content step + its warn-mode optional tail (token-expanded env) run after services up', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'full' },
      new Set<ServiceId>(['iam-api', 'programs-api', 'scheduling-api', 'sessions-api', 'content-api']),
      new Set<ServiceId>(),
    );
    const res = await api.seed(plan);

    expect(res.ok).toBe(true);
    expect(res.ran.online).toContain('content');
    // the demo-polls optional step resolves CONTENT_API from the launch tokens.
    const demoPolls = fakes.runs.find((r) => r.args.includes('seed-demo-polls.mjs'));
    expect(demoPolls?.env.CONTENT_API).toBe('http://localhost:3009');
    // and runs from the synthetic-dev tool dir under SOA (the $SCRIPT_DIR shim).
    expect(demoPolls?.cwd).toBe('/dev/soa/tools/synthetic-dev');
  });
});

// ── verify() / down() / reset() / login() ───────────────────────────────────

describe('StackApi.verify — manifest probes + tolerate', () => {
  it('fails on a down required service unless tolerated by id or repo', async () => {
    const { runtime } = makeRuntime(); // prober answers content down
    const api = makeStackApi(manifest, runtime);
    const probes = healthProbes(manifest, ['iam-api', 'content-api'] as ServiceId[]);

    const strict = await api.verify(probes);
    expect(strict.passed).toBe(false);
    expect(strict.rows.find((r) => r.id === 'content-api')?.ok).toBe(false);

    const tolerated = await api.verify(probes, { tolerate: ['content-api'] });
    expect(tolerated.passed).toBe(true);
    expect(tolerated.rows.find((r) => r.id === 'content-api')?.tolerated).toBe(true);
  });
});

describe('StackApi.down — stop in reverse launch order', () => {
  it('stops dependents before dependencies', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['scheduling-api'] as ServiceId[]);
    await api.down(closure.services);
    // closure(scheduling-api) = {iam-api, scheduling-api}; stop is the reverse.
    expect(fakes.stopped).toEqual(['scheduling-api', 'iam-api']);
  });
});

describe('StackApi.reset — native (M8 R4) + --legacy escape', () => {
  /** The `-c "<sql>"` payload of a `docker exec … psql … -c <sql>` run. */
  const sqlOf = (r: ScriptInvocation): string => r.args[r.args.indexOf('-c') + 1];

  it('native: truncates closure DBs preserving _prisma_migrations + re-seeds the dev user', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['sessions-api'] as ServiceId[]);

    const res = await api.reset(closure.services);

    expect(res.delegated).toBe(false);
    expect(res.code).toBe(0);
    // TRUNCATE ran as docker-exec psql, preserving _prisma_migrations, on soa-postgres-1.
    const truncs = fakes.runs.filter((r) => r.command === 'docker' && r.args.includes('psql'));
    expect(truncs.length).toBeGreaterThan(0);
    for (const t of truncs) {
      expect(t.args.slice(0, 3)).toEqual(['exec', 'soa-postgres-1', 'psql']);
      expect(sqlOf(t)).toContain("tablename <> '_prisma_migrations'");
      expect(sqlOf(t)).toContain('RESTART IDENTITY CASCADE');
    }
    // dev-user re-seed ran (iam-api is in the closure) via the seed path.
    expect(res.seed?.ok).toBe(true);
    expect(res.native?.dbs.some((d) => d.action === 'truncated')).toBe(true);
    // no up.sh delegation on the native path.
    expect(fakes.delegated).toEqual([]);
  });

  it('ledger_local takes migrate-reset (not truncate); connectv3 dropped via mongosh', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);

    const res = await api.reset(['ads-adm-api', 'connect-api', 'iam-api'] as ServiceId[]);
    expect(res.code).toBe(0);

    // ledger_local → `pnpm prisma migrate reset --force` with DATABASE_URL at ledger (NO
    // --skip-seed — prisma 7.8.0's `migrate reset` rejects it; ledger-db configures no seed hook).
    const migReset = fakes.runs.find(
      (r) => r.command === 'pnpm' && r.args.join(' ') === 'prisma migrate reset --force',
    );
    expect(migReset).toBeDefined();
    expect(migReset?.env.DATABASE_URL).toContain('/ledger_local');
    // runs in the ledger-db package (verified schema owner), NOT ads-adm-db.
    expect(migReset?.cwd).toContain('packages/node/ledger-db');
    // ledger_local is NEVER truncated (it's migrate-reset).
    expect(fakes.runs.some((r) => r.command === 'docker' && r.args.includes('ledger_local'))).toBe(false);
    // connectv3 dropped on the mongo container.
    const mongo = fakes.runs.find((r) => r.command === 'docker' && r.args.includes('mongosh'));
    expect(mongo?.args.slice(0, 2)).toEqual(['exec', 'soa-connect-mongo-1']);
    expect(mongo?.args[mongo.args.indexOf('--eval') + 1]).toContain(
      'db.getSiblingDB("connectv3").dropDatabase()',
    );
  });

  it('playback DBs are reset ONLY under withPlayback (idempotent gating)', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    await api.reset(['transcripts-api', 'iam-api'] as ServiceId[]);
    // bare reset leaves the playback DB alone.
    expect(fakes.runs.some((r) => r.command === 'docker' && r.args.includes('transcripts_local'))).toBe(false);

    const { runtime: rt2, fakes: fk2 } = makeRuntime();
    const api2 = makeStackApi(manifest, rt2);
    await api2.reset(['transcripts-api', 'iam-api'] as ServiceId[], { withPlayback: true });
    expect(fk2.runs.some((r) => r.command === 'docker' && r.args.includes('transcripts_local'))).toBe(true);
  });

  it('slot > 0: truncate targets the slot pg container + migrate-reset uses the offset URL', async () => {
    const { runtime, fakes } = makeRuntime({ pgContainer: 'soa-s1-postgres-1', meshOffset: 1000 });
    const api = makeStackApi(manifest, runtime);
    await api.reset(['ads-adm-api', 'iam-api'] as ServiceId[]);
    // truncate hit the slot container.
    const trunc = fakes.runs.find((r) => r.command === 'docker' && r.args.includes('psql'));
    expect(trunc?.args[1]).toBe('soa-s1-postgres-1');
    // ledger migrate-reset URL at the offset mesh port (5432 + 1000).
    const migReset = fakes.runs.find(
      (r) => r.command === 'pnpm' && r.args.join(' ') === 'prisma migrate reset --force',
    );
    expect(migReset?.env.DATABASE_URL).toContain(':6432/ledger_local');
  });

  it('EXIT-CODE CONTRACT: a ledger migrate-reset failure is WARN-only (exit 0) when the core truncates + mongo drop succeeded', async () => {
    // up.sh's reset always exits 0; a wrapper `stack reset && stack up` must not break
    // on the most realistic divergence — a ledger migrate hiccup while every core
    // truncate + the mongo drop succeeded. Only the ledger `pnpm` run fails here.
    const { runtime, fakes } = makeRuntime({
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          fakes.runs.push(spec);
          const isLedgerReset = spec.command === 'pnpm' && spec.args.includes('reset');
          return { code: isLedgerReset ? 1 : 0 };
        },
      },
    });
    const api = makeStackApi(manifest, runtime);

    const res = await api.reset(['ads-adm-api', 'connect-api', 'iam-api'] as ServiceId[]);

    // ledger migrate-reset recorded as failed but the command exit is 0 (warn-only).
    const ledger = res.native?.dbs.find((d) => d.action === 'migrate-reset');
    expect(ledger?.ok).toBe(false);
    expect(res.native?.ok).toBe(false); // the runner-level all-ok flag still reflects it
    expect(res.code).toBe(0); // …but the CONTRACT exit code is 0 — core set succeeded
  });

  it('EXIT-CODE CONTRACT: a real TRUNCATE failure DOES flip the exit code to 1', async () => {
    // The core truncate set stays meaningful — a docker psql truncate failure is a
    // real data failure and must surface as exit 1 (unlike the warn-only ledger case).
    const { runtime, fakes } = makeRuntime({
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          fakes.runs.push(spec);
          const isTruncate = spec.command === 'docker' && spec.args.includes('psql');
          return { code: isTruncate ? 1 : 0 };
        },
      },
    });
    const api = makeStackApi(manifest, runtime);

    const res = await api.reset(['sessions-api', 'iam-api'] as ServiceId[]);
    expect(res.code).toBe(1);
  });

  it('--legacy routes to `up.sh --reset` (non-destructive escape); no native truncate', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const res = await api.reset(['iam-api'] as ServiceId[], { legacy: true });
    expect(res).toEqual({ delegated: true, code: 0 });
    expect(fakes.delegated[0].args).toEqual(['--reset']);
    expect(fakes.runs.some((r) => r.command === 'docker' && r.args.includes('psql'))).toBe(false);
  });

  it('--legacy --with playback → `up.sh --reset --with-playback`', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    await api.reset(['iam-api'] as ServiceId[], { legacy: true, withPlayback: true });
    expect(fakes.delegated[0].args).toEqual(['--reset', '--with-playback']);
  });

  it('--legacy throws without a delegate wired', async () => {
    const { runtime } = makeRuntime({ delegate: undefined });
    const api = makeStackApi(manifest, runtime);
    await expect(api.reset(['iam-api'] as ServiceId[], { legacy: true })).rejects.toThrow(/delegate/);
  });
});

describe('StackApi.seed — R5 stdinFile steps (coach curriculum + playback bootstrap)', () => {
  it('coach curriculum: mongoimport with the resolved mongo container + stdinFile piped', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    // full profile, narrowed to coach-api ⇒ coach-pg + coach-mongo (offline).
    const plan = composeSeedPlan(
      { profile: 'full', only: ['coach-api'] },
      new Set(['coach-api'] as ServiceId[]),
      new Set<ServiceId>(),
    );
    const res = await api.seed(plan);
    expect(res.ok).toBe(true);

    const mongoimports = fakes.runs.filter((r) => r.command === 'docker' && r.args.includes('mongoimport'));
    // both upserts ran: content_coach (main) + content (optional tail).
    expect(mongoimports).toHaveLength(2);
    const [contentCoach, content] = mongoimports;
    // container token expanded to the resolved slot-0 mongo container.
    expect(contentCoach.args.slice(0, 4)).toEqual(['exec', '-i', 'soa-connect-mongo-1', 'mongoimport']);
    // NO dangling ${TOKEN} survives in the argv.
    for (const a of contentCoach.args) expect(a).not.toMatch(/\$\{/);
    // stdinFile resolved to the coach-api fixtures under the COACH repo root.
    expect(contentCoach.stdinFile).toBe('/dev/coach/apps/node/coach-api/scripts/data/content_coach.json');
    expect(contentCoach.args).toContain('content_coach');
    expect(content.stdinFile).toBe('/dev/coach/apps/node/coach-api/scripts/data/content.json');
    expect(content.args).toContain('--jsonArray');
  });

  it('playback provisioning: psql bootstrap from stdin + the migrate tail, gated behind --with playback', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'roster', addOns: ['playback'] },
      new Set(['iam-api', 'sessions-api', 'transcripts-api', 'insights-api', 'chat-api'] as ServiceId[]),
      new Set<ServiceId>(),
    );
    const res = await api.seed(plan);
    expect(res.ok).toBe(true);

    // transcripts bootstrap: docker exec -i <pg> psql, reading local-bootstrap.sql from stdin.
    const bootstrap = fakes.runs.find(
      (r) => r.command === 'docker' && r.args.includes('psql') && r.stdinFile?.includes('transcripts-db'),
    );
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.args.slice(0, 3)).toEqual(['exec', '-i', 'soa-postgres-1']);
    expect(bootstrap?.stdinFile).toBe(
      '/dev/student-data-system/packages/node/transcripts-db/seed/local-bootstrap.sql',
    );
    // the migrate tail ran as MASTER (postgres_admin) after the bootstrap.
    const migrate = fakes.runs.find(
      (r) => r.command === 'pnpm' && r.args.includes('db:deploy') && r.env.DATABASE_URL?.includes('transcripts_local'),
    );
    expect(migrate?.env.DATABASE_URL).toContain('postgres_admin');
  });

  it('slot-0 seed steps WITHOUT a stdinFile carry no stdin redirect (unchanged path)', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const plan = composeSeedPlan(
      { profile: 'roster' },
      new Set(['iam-api', 'sessions-api'] as ServiceId[]),
      new Set<ServiceId>(),
    );
    await api.seed(plan);
    // the iam db:seed steps are unaffected — no stdinFile on any of them.
    for (const r of fakes.runs) expect(r.stdinFile).toBeUndefined();
  });
});

describe('StackApi.login — delegated to up.sh', () => {
  it('login delegates `up.sh --login [email]`', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    await api.login('teacher@saga.org');
    expect(fakes.delegated[0].args).toEqual(['--login', 'teacher@saga.org']);
  });
});
