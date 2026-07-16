/**
 * soa#327 `settlePersonas` — the flow-schema declaration feeding BOTH the bake
 * quiescence barrier and the tunnel post-restore preflight. Pins:
 *  - zod round-trip (declared array survives parse; absent stays undefined);
 *  - resolveFlow carry-through (the resolved flow AND a prerequisite's resolved
 *    flow expose the PRODUCING flow's personas);
 *  - the bundled saga-dash example declares alex.tutor@example.org on journey —
 *    the drift pin against saga-dash's spec constant (TUTOR_EMAIL in
 *    e2e/interactive/connect-session.e2e.test.ts);
 *  - stagePrefixHash EXCLUDES settlePersonas (declaring a probe persona must
 *    not invalidate existing checkpoints — the state the stages produce is
 *    unchanged).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../load.js';
import { resolveFlow } from '../resolve.js';
import { stagePrefixHash } from '../checkpoint.js';
import type { FlowManifest } from '../types.js';

const BUNDLED_SAGA_DASH = fileURLToPath(
  new URL('../../../../examples/flows/saga-dash.flows.json', import.meta.url),
);

function manifestWith(personas?: string[]): FlowManifest {
  return parseFlowManifest(
    JSON.stringify({
      schemaVersion: 1,
      spa: {
        id: 'saga-dash',
        system: 'saga-dash',
        repoEnvVar: 'SAGA_DASH',
        defaultRepoSubpath: 'saga-dash',
        appDir: 'apps/web/dash',
        e2eDir: 'apps/web/dash/e2e',
        playwrightConfig: 'playwright.stack.config.ts',
      },
      flows: [
        {
          name: 'producer',
          description: 'producing flow',
          lanes: ['stack'],
          progressive: true,
          ...(personas !== undefined ? { settlePersonas: personas } : {}),
          stages: [
            {
              id: 'one',
              project: 'stage-1',
              spec: 'one.e2e.test.ts',
              requiredSystems: ['sis-api'],
            },
          ],
        },
        {
          name: 'consumer',
          description: 'flow with the producer as prerequisite',
          lanes: ['stack'],
          progressive: false,
          prerequisite: { flow: 'producer', throughStage: 'one' },
          stages: [
            {
              id: 'live',
              project: 'live',
              spec: 'live.e2e.test.ts',
              requiredSystems: ['sessions-api'],
            },
          ],
        },
      ],
    }),
  );
}

describe('settlePersonas schema + carry-through', () => {
  it('round-trips through zod and reaches the resolved flow', () => {
    const m = manifestWith(['alex.tutor@example.org']);
    expect(m.flows[0]?.settlePersonas).toEqual(['alex.tutor@example.org']);
    const resolved = resolveFlow(m, 'producer');
    expect(resolved.flow.settlePersonas).toEqual(['alex.tutor@example.org']);
  });

  it("a prerequisite's resolved flow exposes the PRODUCING flow's personas", () => {
    const resolved = resolveFlow(manifestWith(['alex.tutor@example.org']), 'consumer');
    expect(resolved.prerequisite?.flow.settlePersonas).toEqual(['alex.tutor@example.org']);
    // The consumer itself declares none — the declaration rides the producer.
    expect(resolved.flow.settlePersonas).toBeUndefined();
  });

  it('absent field stays undefined (no fabricated default)', () => {
    const m = manifestWith();
    expect(m.flows[0]?.settlePersonas).toBeUndefined();
  });

  it('an empty-string persona is a schema violation', () => {
    expect(() => manifestWith([''])).toThrow(/settlePersonas/);
  });

  it('the BUNDLED saga-dash example declares alex.tutor@example.org on journey (spec-constant drift pin)', () => {
    const m = parseFlowManifest(readFileSync(BUNDLED_SAGA_DASH, 'utf8'), BUNDLED_SAGA_DASH);
    const journey = m.flows.find((f) => f.name === 'journey');
    expect(journey?.settlePersonas).toEqual(['alex.tutor@example.org']);
  });

  it('stagePrefixHash ignores settlePersonas (declaring a probe must not invalidate checkpoints)', () => {
    const withPersonas = manifestWith(['alex.tutor@example.org']).flows[0]!;
    const without = manifestWith().flows[0]!;
    expect(stagePrefixHash(withPersonas, withPersonas.stages)).toBe(
      stagePrefixHash(without, without.stages),
    );
  });
});
