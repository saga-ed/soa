/**
 * `executeResolvedFlow` — additive seed (no reset).
 *
 * A flow whose end-state is built by a prerequisite (so `reset` is false) but
 * which declares a `seed` still runs THAT seed on top of the built state — e.g.
 * connect-content publishes its legacy poll into content-api, which the journey
 * prerequisite never seeds (content-api isn't in journey's closure). `--skip-reset`
 * suppresses it (the caller then wants pure state reuse).
 *
 * Offline + deterministic: fake StackApi + Runner. The bundled example flows.json
 * supplies `connect-session` (prerequisite journey@schedule ⇒ reset:false), into
 * which we inject a content-only `seedSelection`. Its journey prerequisite replays
 * and seeds too, so assertions look for the content-ONLY plan among the seeds.
 */

// eslint-disable-next-line no-restricted-imports -- test fixture read; production core stays fs-free
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../core/flow/load.js';
import type { ResolvedFlow } from '../core/flow/index.js';
import { resolveFlow } from '../core/flow/resolve.js';
import type { SeedPlan } from '../core/seed/index.js';
import type { SeedSelection } from '../core/seed/types.js';
import { executeResolvedFlow, isAdditiveSeed } from '../e2e-orchestrate.js';
import type { RunResult, ScriptInvocation } from '../runtime/index.js';
import type { HealthProbe, StackApi, UpResult } from '../stack-api.js';

const EXAMPLE = fileURLToPath(new URL('../../examples/flows/saga-dash.flows.json', import.meta.url));
const flowManifest = parseFlowManifest(readFileSync(EXAMPLE, 'utf8'), EXAMPLE);

// `only:['content-api']` keeps just the content step — it can't clobber the
// prerequisite-built iam/sessions/programs state.
const CONTENT_ONLY_SEED: SeedSelection = { profile: 'full', reset: false, only: ['content-api'] };

interface Captured {
  seedPlans: SeedPlan[];
  logs: string[];
}

function makeFakes(): { api: StackApi; cap: Captured } {
  const cap: Captured = { seedPlans: [], logs: [] };
  const api: StackApi = {
    async up(): Promise<UpResult> {
      return { ok: true, mesh: { ok: true } as UpResult['mesh'], launched: [], skipped: [] };
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
    async verify(_probes: HealthProbe[]) {
      return { passed: true, rows: [] };
    },
  };
  return { api, cap };
}

/** Run connect-session (prerequisite journey@schedule) with an injected seed. */
async function run(
  seedSelection: SeedSelection | undefined,
  skipReset: boolean,
): Promise<{ code: number; cap: Captured }> {
  const { api, cap } = makeFakes();
  const base = resolveFlow(flowManifest, 'connect-session', { headed: false });
  const resolved = { ...base, seedSelection };
  const code = await executeResolvedFlow(
    resolved,
    {
      api,
      runner: {
        async run(_spec: ScriptInvocation): Promise<RunResult> {
          return { code: 0 };
        },
      },
      appCwd: '/virtual/saga-dash/apps/web/dash',
      now: new Date('2026-07-01T12:00:00Z'),
      log: (line: string) => cap.logs.push(line),
    },
    { lane: 'stack', skipReset, passthrough: [] },
  );
  return { code, cap };
}

/** Was a content-ONLY seed plan (the additive one) composed? */
function seededContentOnly(plans: SeedPlan[]): boolean {
  return plans.some((p) => {
    const steps = [...p.offline, ...p.online];
    return steps.length > 0 && steps.every((s) => s.service === 'content-api');
  });
}

describe('executeResolvedFlow — additive seed (no reset) on a prerequisite flow', () => {
  it('runs the declared seed on top of prerequisite-built state (content-api only)', async () => {
    const { code, cap } = await run(CONTENT_ONLY_SEED, false);
    expect(code).toBe(0);
    expect(seededContentOnly(cap.seedPlans)).toBe(true);
    expect(cap.logs.some((l) => l.includes('additive seed (no reset)'))).toBe(true);
  });

  it('does NOT additively seed when the flow declares no seed (baseline)', async () => {
    const { code, cap } = await run(undefined, false);
    expect(code).toBe(0);
    expect(seededContentOnly(cap.seedPlans)).toBe(false);
    expect(cap.logs.some((l) => l.includes('skip reset/seed'))).toBe(true);
  });

  it('respects --skip-reset: no additive seed even with a declared seed', async () => {
    const { code, cap } = await run(CONTENT_ONLY_SEED, true);
    expect(code).toBe(0);
    expect(seededContentOnly(cap.seedPlans)).toBe(false);
  });
});

describe('isAdditiveSeed (predicate)', () => {
  const asResolved = (o: Partial<ResolvedFlow>): ResolvedFlow => o as ResolvedFlow;
  const SEED = CONTENT_ONLY_SEED as ResolvedFlow['seedSelection'];
  const PREREQ = {} as ResolvedFlow['prerequisite'];
  const CHECKPOINT = { fixtureId: 'x', predecessor: 'schedule' } as ResolvedFlow['checkpoint'];

  it('true for a prerequisite flow with a seed (reset false, not skipReset)', () => {
    expect(isAdditiveSeed(asResolved({ reset: false, seedSelection: SEED, prerequisite: PREREQ }), false)).toBe(true);
  });

  it('false for a --from checkpoint flow — a restore is the state source, NEVER re-seed', () => {
    expect(isAdditiveSeed(asResolved({ reset: false, seedSelection: SEED, checkpoint: CHECKPOINT }), false)).toBe(false);
  });

  it('false under --skip-reset (pure state reuse)', () => {
    expect(isAdditiveSeed(asResolved({ reset: false, seedSelection: SEED, prerequisite: PREREQ }), true)).toBe(false);
  });

  it('false when the flow declares no seed', () => {
    expect(isAdditiveSeed(asResolved({ reset: false, prerequisite: PREREQ }), false)).toBe(false);
  });

  it('false for a normal reset flow (effectiveReset owns the seed)', () => {
    expect(isAdditiveSeed(asResolved({ reset: true, seedSelection: SEED }), false)).toBe(false);
  });
});
