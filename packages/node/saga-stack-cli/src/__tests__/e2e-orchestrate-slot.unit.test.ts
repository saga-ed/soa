/**
 * `e2e-orchestrate` SLOT threading (M7) — the split-brain guard for the e2e path.
 *
 * These pin the three slot seams the `e2e run --slot N` orchestrator adds, WITHOUT
 * a live stack / docker / Playwright:
 *   1. `buildStackContext(flags, seams, delegate, profile)` — at slot > 0 the
 *      runtime carries `meshProject=soa-s<N>` + `meshOffset=N*1000` + offset
 *      `launchContext.ports`; at slot 0 the slot-OFFSET fields are omitted (base
 *      mesh project + base ports). Since FLIP 3 the native-prep seams (`pgProbe`/…)
 *      are wired at EVERY slot — including slot 0 — so `StackApi.up` migrates the
 *      schema before seed regardless of slot.
 *   2. `serviceUrlEnv` / `playwrightEnv` — the Playwright service URLs carry the
 *      slot offset (base + N*1000) at slot > 0 and the base ports at slot 0.
 *   3. `describeResolved` — the slot's excluded services are dropped from the closure.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveInstance } from '../core/derive-instance.js';
import {
  buildStackContext,
  playwrightArgv,
  playwrightEnv,
  serviceUrlEnv,
  tunnelServiceUrlEnv,
  TUNNEL_PLAYWRIGHT_TIMEOUT_MS,
  type StackSeams,
} from '../e2e-orchestrate.js';
import type {
  DashFs,
  HealthProber,
  MeshExec,
  PgProbe,
  PortProbe,
  Runner,
  ServiceLauncher,
} from '../runtime/index.js';
import type { ResolvedFlow } from '../core/flow/index.js';

const SOA_ROOT = resolve(process.cwd(), '..', '..', '..');
const FLAGS = { dev: '/fixed/dev', soa: SOA_ROOT } as Record<string, unknown>;
const delegate = async (): Promise<number> => 0;

/** A sentinel pgProbe so we can assert identity when it is wired at slot > 0. */
const PG_PROBE = { tag: 'pg' } as unknown as PgProbe;

function seams(): StackSeams {
  return {
    launcher: {} as ServiceLauncher,
    meshExec: {} as MeshExec,
    portProbe: {} as PortProbe,
    dashFs: {} as DashFs,
    prober: {} as HealthProber,
    runner: {} as Runner,
    pgProbe: PG_PROBE,
    prepIsFresh: () => true,
    prepDbGenerateScan: () => [],
    repoDirExists: () => true,
  };
}

describe('buildStackContext — slot threading (parity with stack up buildRuntime)', () => {
  it('slot > 0: meshProject=soa-s1, meshOffset=1000, offset ports, pgProbe wired', () => {
    const profile = deriveInstance({ slot: 1 });
    const { runtime } = buildStackContext(FLAGS, seams(), delegate, profile);

    expect(runtime.slot).toBe(1);
    expect(runtime.meshProject).toBe('soa-s1');
    expect(runtime.meshOffset).toBe(1000);
    expect(runtime.pgProbe).toBe(PG_PROBE);

    // launchContext.ports carry the +1000 offset (base + slot*1000).
    expect(runtime.launchContext.ports['iam-api']).toBe(4010); // 3010 + 1000
    expect(runtime.launchContext.ports['scheduling-api']).toBe(4008); // 3008 + 1000
    expect(runtime.launchContext.ports['sessions-api']).toBe(4007); // 3007 + 1000
    expect(runtime.launchContext.ports['saga-dash']).toBe(9900); // 8900 + 1000
    // The mesh DB URLs carry the offset too (postgres 5432 → 6432 at slot 1).
    expect(runtime.launchContext.tokens.SCHEDULING_DB_URL).toContain('@localhost:6432/');
  });

  it('a larger slot compounds the stride (slot 3 ⇒ +3000)', () => {
    const { runtime } = buildStackContext(FLAGS, seams(), delegate, deriveInstance({ slot: 3 }));
    expect(runtime.meshProject).toBe('soa-s3');
    expect(runtime.meshOffset).toBe(3000);
    expect(runtime.launchContext.ports['iam-api']).toBe(6010); // 3010 + 3000
  });

  it('slot 0: slot-OFFSET fields omitted + base ports, but prep seams STILL wired (FLIP 3)', () => {
    const profile = deriveInstance({ slot: 0 });
    const { runtime } = buildStackContext(FLAGS, seams(), delegate, profile);

    // The slot-OFFSET machinery is a NO-OP at slot 0: the fields are OMITTED, not set to 0.
    expect(runtime.slot).toBeUndefined();
    expect(runtime.meshProject).toBeUndefined();
    expect(runtime.meshOffset).toBeUndefined();

    // FLIP 3: the native-prep seams ARE wired at slot 0 now — up.sh --reset no longer
    // migrates the schema, so `StackApi.up` must run R1 build → R2 provision → R3 migrate
    // at slot 0 too (else 0 migrations → seed-dev-user hits TableDoesNotExist).
    expect(runtime.pgProbe).toBe(PG_PROBE);
    expect(typeof runtime.prepIsFresh).toBe('function');
    expect(typeof runtime.prepDbGenerateScan).toBe('function');
    expect(typeof runtime.repoDirExists).toBe('function');

    // Base ports (no offset) — identical to the pre-slot launch context.
    expect(runtime.launchContext.ports['iam-api']).toBe(3010);
    expect(runtime.launchContext.ports['saga-dash']).toBe(8900);
    expect(runtime.launchContext.tokens.SCHEDULING_DB_URL).toContain('@localhost:5432/');
  });

  it('the DEFAULT profile (no arg) is slot 0 — back-compat for the connect command', () => {
    const { runtime } = buildStackContext(FLAGS, seams(), delegate);
    expect(runtime.slot).toBeUndefined();
    // prep seams wired even on the default (slot-0) profile (FLIP 3).
    expect(runtime.pgProbe).toBe(PG_PROBE);
    expect(runtime.launchContext.ports['iam-api']).toBe(3010);
  });

  it('--tunnel: the domain reaches the LAUNCH TOKENS, not just the Runtime (soa#322)', () => {
    // Without TUNNEL_DOMAIN in the tokens, tunnelOverlay() returns {} for every
    // service this path auto-launches — `develop … --tunnel` then serves pages over
    // the public tunnel origin whose inlined VITE_*/PUBLIC_* still say localhost.
    // Runtime.tunnelDomain alone only drives Playwright URLs + the dash hook.
    const { runtime } = buildStackContext(
      FLAGS,
      seams(),
      delegate,
      deriveInstance({ slot: 0 }),
      'x.vms.wootdev.com',
    );
    expect(runtime.tunnel).toBe(true);
    expect(runtime.tunnelDomain).toBe('x.vms.wootdev.com');
    expect(runtime.launchContext.tokens.TUNNEL_DOMAIN).toBe('x.vms.wootdev.com');
  });

  it('no --tunnel: no TUNNEL_DOMAIN token (local launches stay overlay-free)', () => {
    const { runtime } = buildStackContext(FLAGS, seams(), delegate);
    expect(runtime.launchContext.tokens.TUNNEL_DOMAIN).toBeUndefined();
  });
});

describe('serviceUrlEnv / playwrightEnv — offset Playwright service URLs', () => {
  const p1 = deriveInstance({ slot: 1 }).portOverrides;
  const p0 = deriveInstance({ slot: 0 }).portOverrides;

  it('slot 1 ports ⇒ every service URL carries the +1000 offset', () => {
    const env = serviceUrlEnv(p1);
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:9900'); // saga-dash
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:4010');
    expect(env.PLAYWRIGHT_SCHEDULING_URL).toBe('http://localhost:4008');
    expect(env.PLAYWRIGHT_SESSIONS_URL).toBe('http://localhost:4007');
    expect(env.PLAYWRIGHT_PROGRAMS_URL).toBe('http://localhost:4006');
    expect(env.PLAYWRIGHT_SIS_URL).toBe('http://localhost:4100');
    // soa#271: connect-api ingress is slottable now — its URL carries the offset too.
    expect(env.PLAYWRIGHT_CONNECT_API_URL).toBe('http://localhost:7106'); // 6106 + 1000
  });

  it('slot 0 ports ⇒ the base URLs (behaviour-identical to lane.ts defaults)', () => {
    const env = serviceUrlEnv(p0);
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:8900');
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:3010');
    expect(env.PLAYWRIGHT_SCHEDULING_URL).toBe('http://localhost:3008');
    expect(env.PLAYWRIGHT_SESSIONS_URL).toBe('http://localhost:3007');
    expect(env.PLAYWRIGHT_CONNECT_API_URL).toBe('http://localhost:6106'); // base = lane.ts default
  });

  const flow = { name: 'journey', env: undefined } as unknown as ResolvedFlow['flow'];
  const resolved = { flow } as ResolvedFlow;
  const now = new Date('2026-06-30T12:00:00'); // a Tuesday — deterministic clamp

  it('playwrightEnv (stack lane) overlays the OFFSET URLs at slot 1 and keeps the date env', () => {
    const env = playwrightEnv(resolved, now, 'stack', p1);
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:9900');
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:4010');
    // the Monday-flake date env still rides along.
    expect(env.PLAYWRIGHT_OCCURRENCE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('playwrightEnv (stack lane) overlays the BASE URLs at slot 0 (the split-brain guard)', () => {
    const env = playwrightEnv(resolved, now, 'stack', p0);
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:8900');
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:3010');
  });

  it('a non-dash SPA (coach-web) gets ITS OWN port for PLAYWRIGHT_BASE_URL, not saga-dash\'s (regression: coach-web/dashboard opened :8900 and 500\'d before this fix)', () => {
    const coachResolved = {
      flow,
      spa: { id: 'coach-web', system: 'coach-web' },
    } as unknown as ResolvedFlow;
    const env = playwrightEnv(coachResolved, now, 'stack', p0);
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:8800'); // coach-web, NOT :8900 (saga-dash)
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:3010');
  });

  it('playwrightEnv on a DEPLOYED lane does NOT inject localhost URLs (lane.ts owns the hostnames)', () => {
    const env = playwrightEnv(resolved, now, 'sandbox', p1);
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_IAM_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_LANE).toBe('sandbox');
  });

  it('a flow.env pinning a PLAYWRIGHT_*_URL does NOT override the slot offset at slot > 0 (split-brain guard)', () => {
    // A flow that pins the base (slot-0) iam URL in its own env — the hardening case.
    const pinnedFlow = {
      name: 'journey',
      env: { PLAYWRIGHT_IAM_URL: 'http://localhost:3010' },
    } as unknown as ResolvedFlow['flow'];
    const pinnedResolved = { flow: pinnedFlow } as ResolvedFlow;

    const env = playwrightEnv(pinnedResolved, now, 'stack', p1);
    // The slot-1 offset (:4010) MUST win over the flow.env pin (:3010) for service URLs.
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:4010');
    expect(env.PLAYWRIGHT_IAM_URL).not.toBe('http://localhost:3010'); // NOT slot 0's iam
  });

  it('flow.env STILL wins for the date env (the occurrence-date clamp) at slot > 0', () => {
    const dateFixedFlow = {
      name: 'journey',
      env: { PLAYWRIGHT_OCCURRENCE_DATE: '2026-01-05' },
    } as unknown as ResolvedFlow['flow'];
    const dateResolved = { flow: dateFixedFlow } as ResolvedFlow;

    const env = playwrightEnv(dateResolved, now, 'stack', p1);
    // Service URLs still carry the offset...
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:4010');
    // ...while flow.env keeps winning for the date env.
    expect(env.PLAYWRIGHT_OCCURRENCE_DATE).toBe('2026-01-05');
  });
});

describe('playwrightArgv — spec scoping (single-spawn only, never on a stage override)', () => {
  const specResolved = {
    playwright: {
      config: 'playwright.config.ts',
      project: 'chromium',
      headed: false,
      spec: 'dashboard/dashboard-authenticated.e2e.smoke.test.ts',
    },
  } as unknown as ResolvedFlow;

  it('the single-spawn path (no stage override) pushes the terminal spec — scopes a single-project SPA to just that spec', () => {
    const argv = playwrightArgv(specResolved);
    expect(argv).toEqual([
      'exec',
      'playwright',
      'test',
      '--config=playwright.config.ts',
      '--project',
      'chromium',
      'dashboard/dashboard-authenticated.e2e.smoke.test.ts',
    ]);
  });

  it('a stage override (bake/--from per-stage spawn) does NOT push the terminal spec (regression guard: pushing it would filter a non-terminal stage.project to a spec it does not contain, running zero tests)', () => {
    const argv = playwrightArgv(specResolved, [], { project: 'stage-2-program', noDeps: true });
    expect(argv).toEqual([
      'exec',
      'playwright',
      'test',
      '--config=playwright.config.ts',
      '--project',
      'stage-2-program',
      '--no-deps',
    ]);
    expect(argv).not.toContain('dashboard/dashboard-authenticated.e2e.smoke.test.ts');
  });

  it('a flow with no spec (progressive saga-dash flows omit it) never pushes an extra positional arg', () => {
    const noSpecResolved = {
      playwright: { config: 'playwright.stack.config.ts', project: 'stage-4-pods', headed: false },
    } as unknown as ResolvedFlow;
    const argv = playwrightArgv(noSpecResolved);
    expect(argv).toEqual(['exec', 'playwright', 'test', '--config=playwright.stack.config.ts', '--project', 'stage-4-pods']);
  });
});
