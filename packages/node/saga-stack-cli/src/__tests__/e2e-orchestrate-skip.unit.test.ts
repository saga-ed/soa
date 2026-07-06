/**
 * `executeResolvedFlow` — repo-absent skip wiring (#221 coach-deferral d).
 *
 * `stack up` warns-and-skips a service whose sibling repo isn't cloned (plus its
 * hard dependents). This suite pins the SAME seed-active-set pattern downstream
 * in the e2e orchestrator: a service `up()` reported skipped must be
 *  - dropped from the composed seed plan (its steps degrade to
 *    `service-inactive` skip notes, never spawned against a missing checkout),
 *  - dropped from the verify probe list (a never-launched service must not
 *    redden the run), and
 *  - surfaced as a warning line.
 *
 * Offline + deterministic: fake StackApi + Runner; the bundled example
 * flows.json supplies the resolved journey flow. No processes, no network.
 */

// eslint-disable-next-line no-restricted-imports -- test fixture read; production core stays fs-free
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../core/flow/load.js';
import { resolveFlow } from '../core/flow/resolve.js';
import type { ServiceId } from '../core/manifest/index.js';
import type { SeedPlan } from '../core/seed/index.js';
import { executeResolvedFlow } from '../e2e-orchestrate.js';
import type { RunResult, ScriptInvocation } from '../runtime/index.js';
import type { HealthProbe, StackApi, UpResult, UpSkip } from '../stack-api.js';

const EXAMPLE = fileURLToPath(new URL('../../examples/flows/saga-dash.flows.json', import.meta.url));
const flowManifest = parseFlowManifest(readFileSync(EXAMPLE, 'utf8'), EXAMPLE);

interface Captured {
  upServices: ServiceId[][];
  seedPlans: SeedPlan[];
  verifyProbes: HealthProbe[][];
  playwright: ScriptInvocation[];
  logs: string[];
}

/** Fake StackApi: up() reports `skips`; seed/verify/reset record + succeed. */
function makeFakes(skips: UpSkip[]): { api: StackApi; cap: Captured } {
  const cap: Captured = { upServices: [], seedPlans: [], verifyProbes: [], playwright: [], logs: [] };
  const api: StackApi = {
    async up(services: ServiceId[]): Promise<UpResult> {
      cap.upServices.push(services);
      return {
        ok: true,
        mesh: { ok: true } as UpResult['mesh'],
        launched: [],
        skipped: skips,
      };
    },
    async down() {
      return { stopped: [] };
    },
    async restart() {
      throw new Error('unused');
    },
    async reset() {
      return { code: 0 };
    },
    async seed(plan: SeedPlan) {
      cap.seedPlans.push(plan);
      return { ok: true, ran: { offline: [], online: [] }, skipped: plan.skipped };
    },
    async verify(probes: HealthProbe[]) {
      cap.verifyProbes.push(probes);
      return { passed: true, rows: [] };
    },
  };
  return { api, cap };
}

async function run(skips: UpSkip[]): Promise<{ code: number; cap: Captured }> {
  const { api, cap } = makeFakes(skips);
  const code = await executeResolvedFlow(
    resolveFlow(flowManifest, 'journey', { headed: false }),
    {
      api,
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          cap.playwright.push(spec);
          return { code: 0 };
        },
      },
      appCwd: '/virtual/saga-dash/apps/web/dash',
      now: new Date('2026-07-01T12:00:00Z'),
      log: (line: string) => cap.logs.push(line),
    },
    { lane: 'stack', skipReset: false, passthrough: [] },
  );
  return { code, cap };
}

const SESSIONS_SKIP: UpSkip = {
  id: 'sessions-api',
  repo: 'PROGRAM_HUB',
  repoDir: '/dev/program-hub',
  message: 'sessions-api skipped — repo dir /dev/program-hub not present (PROGRAM_HUB repo not cloned)',
};

describe('executeResolvedFlow — honours up() repo-absent skips (#221 d)', () => {
  it('drops a skipped service from the seed active set AND the verify probes; warns; still exits 0', async () => {
    const { code, cap } = await run([SESSIONS_SKIP]);
    expect(code).toBe(0);

    // Seed: the journey roster profile normally seeds sessions — with
    // sessions-api skipped, its step degrades to a service-inactive skip note.
    expect(cap.seedPlans).toHaveLength(1);
    const plan = cap.seedPlans[0] as SeedPlan;
    const planned = [...plan.offline, ...plan.online];
    expect(planned.map((s) => s.id)).toContain('iam'); // the rest still seeds
    expect(planned.some((s) => s.service === 'sessions-api')).toBe(false);
    expect(plan.skipped.some((n) => n.service === 'sessions-api' && n.reason === 'service-inactive')).toBe(true);

    // Verify: no probe for the never-launched service.
    expect(cap.verifyProbes).toHaveLength(1);
    const probeIds = (cap.verifyProbes[0] as HealthProbe[]).map((p) => p.id);
    expect(probeIds).not.toContain('sessions-api');
    expect(probeIds).toContain('iam-api');

    // The skip is surfaced as a warning line.
    expect(cap.logs.some((l) => l.includes('sessions-api skipped'))).toBe(true);

    // Playwright still ran (the skip guard keeps the run green).
    expect(cap.playwright).toHaveLength(1);
  });

  it('no skips ⇒ full closure seeded and probed (baseline unchanged)', async () => {
    const { code, cap } = await run([]);
    expect(code).toBe(0);
    const plan = cap.seedPlans[0] as SeedPlan;
    expect([...plan.offline, ...plan.online].some((s) => s.service === 'sessions-api')).toBe(true);
    expect((cap.verifyProbes[0] as HealthProbe[]).map((p) => p.id)).toContain('sessions-api');
  });
});
