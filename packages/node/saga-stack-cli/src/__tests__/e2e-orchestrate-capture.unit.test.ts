/**
 * `executeResolvedFlow` — exploratory-review capture wiring (docs/e2e-review.md).
 *
 * Pins the three seams `e2e run --capture` adds, offline (fake StackApi +
 * Runner, the bundled example flows.json):
 *   1. `playwrightEnv(…, capture)` — PLAYWRIGHT_CAPTURE=all rides the child env
 *      iff capture; absent otherwise (byte-identical default).
 *   2. the preservation hook fires after EVERY spawn of a --capture run, and
 *      after a RED spawn without it — never after a green non-capture spawn.
 *   3. a red spawn's exit code still propagates unchanged.
 */

// eslint-disable-next-line no-restricted-imports -- test fixture read; production core stays fs-free
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../core/flow/load.js';
import { resolveFlow } from '../core/flow/resolve.js';
import type { SeedPlan } from '../core/seed/index.js';
import { executeResolvedFlow, playwrightEnv } from '../e2e-orchestrate.js';
import type { RunResult, ScriptInvocation } from '../runtime/index.js';
import type { HealthProbe, StackApi } from '../stack-api.js';

const EXAMPLE = fileURLToPath(new URL('../../examples/flows/saga-dash.flows.json', import.meta.url));
const flowManifest = parseFlowManifest(readFileSync(EXAMPLE, 'utf8'), EXAMPLE);

function makeApi(): StackApi {
  return {
    async up() {
      return { ok: true, mesh: { ok: true } as never, launched: [], skipped: [] };
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
      return { ok: true, ran: { offline: [], online: [] }, skipped: plan.skipped };
    },
    async verify(_probes: HealthProbe[]) {
      return { passed: true, rows: [] };
    },
  };
}

async function run(opts: { capture?: boolean; playwrightCode?: number }): Promise<{
  code: number;
  spawnedEnvs: Array<Record<string, string> | undefined>;
  preserveCalls: Array<{ flowName: string; stages: readonly { id: string; project: string }[] }>;
}> {
  const spawnedEnvs: Array<Record<string, string> | undefined> = [];
  const preserveCalls: Array<{ flowName: string; stages: readonly { id: string; project: string }[] }> = [];
  const code = await executeResolvedFlow(
    resolveFlow(flowManifest, 'journey', { headed: false }),
    {
      api: makeApi(),
      runner: {
        async run(spec: ScriptInvocation): Promise<RunResult> {
          spawnedEnvs.push(spec.env);
          return { code: opts.playwrightCode ?? 0 };
        },
      },
      appCwd: '/virtual/saga-dash/apps/web/dash',
      now: new Date('2026-07-01T12:00:00Z'),
      log: () => {},
      preserveTraces: (frame) => {
        preserveCalls.push({ flowName: frame.flowName, stages: frame.stages });
      },
    },
    { lane: 'stack', skipReset: false, passthrough: [], capture: opts.capture },
  );
  return { code, spawnedEnvs, preserveCalls };
}

describe('playwrightEnv — capture knob', () => {
  const resolved = resolveFlow(flowManifest, 'journey', { headed: false });
  const now = new Date('2026-07-01T12:00:00Z');

  it('injects PLAYWRIGHT_CAPTURE=all iff capture', () => {
    expect(playwrightEnv(resolved, now, 'stack', undefined, undefined, true).PLAYWRIGHT_CAPTURE).toBe('all');
    expect(playwrightEnv(resolved, now, 'stack')).not.toHaveProperty('PLAYWRIGHT_CAPTURE');
    expect(playwrightEnv(resolved, now, 'stack', undefined, undefined, false)).not.toHaveProperty(
      'PLAYWRIGHT_CAPTURE',
    );
  });
});

describe('executeResolvedFlow — preservation hook firing rules', () => {
  it('--capture green: env carries the knob and the hook fires with the flow frame', async () => {
    const { code, spawnedEnvs, preserveCalls } = await run({ capture: true });
    expect(code).toBe(0);
    expect(spawnedEnvs[0]?.PLAYWRIGHT_CAPTURE).toBe('all');
    expect(preserveCalls).toHaveLength(1);
    expect(preserveCalls[0].flowName).toBe('journey');
    expect(preserveCalls[0].stages.map((s) => s.id)).toContain('roster');
  });

  it('green without --capture: no knob, no preservation (byte-identical default)', async () => {
    const { code, spawnedEnvs, preserveCalls } = await run({});
    expect(code).toBe(0);
    expect(spawnedEnvs[0]).not.toHaveProperty('PLAYWRIGHT_CAPTURE');
    expect(preserveCalls).toHaveLength(0);
  });

  it('RED without --capture: the failure artifacts are preserved and the code propagates', async () => {
    const { code, preserveCalls } = await run({ playwrightCode: 7 });
    expect(code).toBe(7);
    expect(preserveCalls).toHaveLength(1);
  });
});
