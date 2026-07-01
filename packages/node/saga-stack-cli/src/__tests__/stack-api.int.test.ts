/**
 * StackApi facade INTEGRATION tests (plan §6.3 / §7.2 "M4 — Native partial-stack").
 *
 * Where `stack-api.unit.test.ts` exercises each facade method in isolation, this
 * suite drives the WHOLE M4 native bring-up sequence through `makeStackApi` over a
 * concrete dependency closure — the same plan `stack up --only …` runs — with
 * FAKE seams only (launcher / meshExec / portProbe / dashFs / prober / runner).
 * NOTHING is spawned: no `pnpm dev`, no `make up`, no `docker`, no fetch, no fs.
 *
 * The integration contract under test (the M4 headline payoff):
 *   up(closure) → checkPorts preflight (every mesh host port probed) → ONE
 *   `make up` in <soa>/infra → readiness-gate the closure's mesh units → (dash
 *   prelaunch hook only when saga-dash is present) → launch EXACTLY the closure,
 *   in topo-wave order, each with its FAITHFUL resolved env + a health URL to
 *   poll → seed(plan) runs the composed offline steps, THEN the online steps,
 *   through the Runner.
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../core/closure.js';
import { defaultLaunchContext } from '../core/launch-plan.js';
import type { LaunchContext } from '../core/launch-plan.js';
import { manifest } from '../core/manifest/index.js';
import type { RepoKey, ServiceId } from '../core/manifest/index.js';
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

const REPO_ROOTS = {
  SOA: '/dev/soa',
  ROSTERING: '/dev/rostering',
  PROGRAM_HUB: '/dev/program-hub',
  SAGA_DASH: '/dev/saga-dash',
  COACH: '/dev/coach',
  SDS: '/dev/student-data-system',
  QBOARD: '/dev/qboard',
  RTSM: '/dev/rtsm',
  FLEEK: '/dev/fleek',
} as Record<RepoKey, string>;

function ctx(): LaunchContext {
  return defaultLaunchContext({ repoRoots: REPO_ROOTS, syntheticDevDir: '/dev/soa/tools/synthetic-dev' });
}

interface Fakes {
  /** Specs handed to the launcher, in call order (the flattened topo waves). */
  launches: LaunchSpec[];
  /** Health URLs the launcher was asked to poll, in launch order. */
  polled: string[];
  /** Runner invocations (mesh `make up` + native seed steps). */
  runs: ScriptInvocation[];
  /** Host ports the `check_ports` preflight probed (proves checkPorts ran). */
  probedPorts: number[];
  /** Mesh containers readiness-gated. */
  meshGated: string[];
  /** DashFs touches (proves / disproves the prelaunch hook fired). */
  dashCalls: string[];
}

/** A full fake runtime; `launchFail` ids answer health-down so a wave aborts. */
function makeRuntime(launchFail: Set<string> = new Set()): { runtime: Runtime; fakes: Fakes } {
  const fakes: Fakes = {
    launches: [],
    polled: [],
    runs: [],
    probedPorts: [],
    meshGated: [],
    dashCalls: [],
  };

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      fakes.launches.push(spec);
      fakes.polled.push(spec.healthUrl);
      return { id: spec.id, ok: !launchFail.has(spec.id), pid: 4000 + fakes.launches.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true, pid: 1 }));
    },
  };
  const meshExec: MeshExec = {
    async ready(container: string): Promise<boolean> {
      fakes.meshGated.push(container);
      return true;
    },
  };
  const portProbe: PortProbe = {
    async dockerHolder(port: number): Promise<string | null> {
      fakes.probedPorts.push(port);
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
    async probe() {
      return { ok: true, status: 200 };
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
  };
  return { runtime, fakes };
}

// The explicit closure the task pins: iam-api + the programs/scheduling/sessions trio.
const FOUR: ServiceId[] = ['iam-api', 'programs-api', 'scheduling-api', 'sessions-api'];

describe('StackApi.up — full native bring-up over a concrete closure', () => {
  it('preflights every mesh port, runs make up ONCE, gates only the closure units, launches the closure in topo order', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);

    const res = await api.up(FOUR);

    expect(res.ok).toBe(true);

    // checkPorts preflight: every mesh host port was probed before make up
    // (postgres 5432, redis 6379, rabbitmq 5672 + mgmt 15672, connect-mongo 27037).
    expect(fakes.probedPorts).toEqual([5432, 6379, 5672, 15672, 27037]);

    // meshUp once: exactly one `make up`, in <soa>/infra, with manifest-derived ports.
    const makeRuns = fakes.runs.filter((r) => r.command === 'make');
    expect(makeRuns).toHaveLength(1);
    expect(makeRuns[0].cwd).toBe('/dev/soa/infra');
    expect(makeRuns[0].args).toContain('up');
    expect(makeRuns[0].args).toContain('POSTGRES_PORT=5432');

    // only the closure's mesh units are readiness-gated (no mongo / redis for this set).
    expect(fakes.meshGated).toEqual(['soa-postgres-1', 'soa-rabbitmq-1']);
    expect(res.mesh.units.map((u) => u.id)).toEqual(['postgres', 'rabbitmq']);

    // launched EXACTLY the closure, deps before dependents.
    expect(fakes.launches.map((s) => s.id)).toEqual(FOUR);
    expect(res.launched.map((r) => r.id)).toEqual(FOUR);
    expect(res.launched.every((r) => r.ok)).toBe(true);

    // saga-dash absent ⇒ the dash prelaunch hook never touched the fs.
    expect(fakes.dashCalls).toEqual([]);
    expect(res.dash).toBeUndefined();
  });

  it('health-polls EACH launched service (every spec carries its resolved stack-lane health URL)', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);

    await api.up(FOUR);

    // one health URL polled per service, in launch order, each on its own port.
    expect(fakes.polled).toEqual([
      'http://localhost:3010/health', // iam-api
      'http://localhost:3006/health', // programs-api
      'http://localhost:3008/health', // scheduling-api
      'http://localhost:3007/health', // sessions-api
    ]);
  });

  it('hands each service its FAITHFUL fully-resolved launch env (no dangling ${TOKEN}s)', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);

    await api.up(FOUR);
    const byId = new Map(fakes.launches.map((s) => [s.id, s]));

    // command split from the manifest `pnpm dev`.
    expect(byId.get('iam-api')!.command).toBe('pnpm');
    expect(byId.get('iam-api')!.args).toEqual(['dev']);

    // representative env walls (the up.sh services_up launch_if lines):
    expect(byId.get('iam-api')!.env).toMatchObject({
      PORT: '3010',
      AUTH_DEVUSERID: 'f0000004-0000-4000-8000-00000000beef',
    });
    expect(byId.get('programs-api')!.env).toMatchObject({
      DATABASE_URL: 'postgresql://saga_user:password123@localhost:5432/programs',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:5672',
      IAM_API_URL: 'http://localhost:3010',
    });
    expect(byId.get('sessions-api')!.env).toMatchObject({
      DATABASE_URL: 'postgresql://saga_user:password123@localhost:5432/sessions',
      CORS_ORIGIN: 'http://localhost:8900',
    });

    // every resolved value across the whole closure is token-free.
    for (const spec of fakes.launches) {
      for (const v of Object.values(spec.env)) expect(v).not.toMatch(/\$\{/);
    }
  });

  it('fires the dash prelaunch hook (and launches saga-dash) when saga-dash is in the closure', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);
    const closure = computeClosure(manifest, ['saga-dash'] as ServiceId[]);

    const res = await api.up(closure.services);

    expect(fakes.launches.some((s) => s.id === 'saga-dash')).toBe(true);
    // non-tunnel + no existing config.local.json ⇒ a clean noop-absent (the hook ran).
    expect(res.dash?.action).toBe('noop-absent');
    expect(fakes.dashCalls.some((c) => c.startsWith('existsDir:'))).toBe(true);
  });

  it('aborts the bring-up (ok:false, failedAt) and stops launching the rest when a wave goes unhealthy', async () => {
    const { runtime, fakes } = makeRuntime(new Set(['iam-api']));
    const api = makeStackApi(manifest, runtime);

    const res = await api.up(FOUR);

    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('iam-api');
    // iam-api is wave 1; its dependents are never launched.
    expect(fakes.launches.map((s) => s.id)).toEqual(['iam-api']);
  });
});

describe('StackApi.up — skips a service whose sibling repo is not cloned (warn, not fail)', () => {
  it('launches services whose repo is present and SKIPS the coach pair when COACH is absent', async () => {
    const { runtime, fakes } = makeRuntime();
    // COACH checkout absent on disk; every other repo present.
    runtime.repoDirExists = (dir: string) => dir !== REPO_ROOTS.COACH;
    const api = makeStackApi(manifest, runtime);

    // closure(coach-web) = coach-web + coach-api (COACH, absent) + iam-api (present).
    const closure = computeClosure(manifest, ['coach-web'] as ServiceId[]);

    const res = await api.up(closure.services);

    // the run does NOT fail — the missing repo is a warning, not an error.
    expect(res.ok).toBe(true);

    // only iam-api (a present repo) launched; the coach pair was skipped, not spawned.
    expect(fakes.launches.map((s) => s.id)).toEqual(['iam-api']);

    // both coach services are reported skipped, with the repo dir + a clear message.
    expect(res.skipped.map((s) => s.id).sort()).toEqual(['coach-api', 'coach-web']);
    for (const s of res.skipped) {
      expect(s.repo).toBe('COACH');
      expect(s.repoDir).toBe(REPO_ROOTS.COACH);
      expect(s.message).toMatch(/not present.*COACH repo not cloned/);
    }
  });

  it('launches everything (no skips) when repoDirExists reports every repo present', async () => {
    const { runtime, fakes } = makeRuntime();
    runtime.repoDirExists = () => true;
    const api = makeStackApi(manifest, runtime);

    const res = await api.up(['iam-api', 'coach-api'] as ServiceId[]);

    expect(res.ok).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(fakes.launches.map((s) => s.id)).toEqual(['iam-api', 'coach-api']);
  });
});

describe('StackApi — up() then seed() run the composed offline-THEN-online plan', () => {
  it('seeds offline steps before online steps, over the active closure, through the Runner', async () => {
    const { runtime, fakes } = makeRuntime();
    const api = makeStackApi(manifest, runtime);

    // a closure that pulls in content-api so the composed plan has BOTH phases.
    const closure = computeClosure(manifest, ['sessions-api', 'content-api'] as ServiceId[]);

    const up = await api.up(closure.services);
    expect(up.ok).toBe(true);
    expect(up.launched.some((r) => r.id === 'content-api')).toBe(true);

    const plan = composeSeedPlan(
      { profile: 'full' },
      new Set<ServiceId>(closure.services),
      new Set<ServiceId>(),
    );
    // sanity: the composed plan really has both phases.
    expect(plan.offline.length).toBeGreaterThan(0);
    expect(plan.online.map((s) => s.id)).toContain('content');

    // count the runs before seeding (mesh make up + nothing else yet).
    const beforeSeed = fakes.runs.length;
    const res = await api.seed(plan);

    expect(res.ok).toBe(true);
    // offline ids reported first, online after — both non-empty.
    expect(res.ran.offline).toEqual(plan.offline.map((s) => s.id));
    expect(res.ran.online).toContain('content');

    // and in the actual Runner call sequence the offline steps physically precede
    // the online content step (offline-THEN-online ordering, not just bookkeeping).
    // The offline `iam` step is `pnpm db:seed` in the iam-db package; the online
    // content step's `seed-demo-polls.mjs` tail is an unambiguous online-phase run.
    const seedRuns = fakes.runs.slice(beforeSeed);
    const offlineIamIdx = seedRuns.findIndex((r) => r.args.includes('db:seed') && r.cwd.includes('iam-db'));
    const onlineDemoPollsIdx = seedRuns.findIndex((r) => r.args.includes('seed-demo-polls.mjs'));
    expect(offlineIamIdx).toBeGreaterThanOrEqual(0);
    expect(onlineDemoPollsIdx).toBeGreaterThan(offlineIamIdx);

    // the online content optional demo-polls tail resolved its CONTENT_API token and
    // ran from the synthetic-dev tool dir under SOA (the $SCRIPT_DIR shim).
    const demoPolls = fakes.runs.find((r) => r.args.includes('seed-demo-polls.mjs'));
    expect(demoPolls?.env.CONTENT_API).toBe('http://localhost:3009');
    expect(demoPolls?.cwd).toBe('/dev/soa/tools/synthetic-dev');
  });
});
