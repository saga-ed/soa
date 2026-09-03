/**
 * How `resolveFlow` decides which optional services enter a flow's closure.
 *
 * The three families are admitted by DIFFERENT rules, and the divergence is
 * deliberate. No authored flow exercises any of it (none names an optional
 * service in `requiredSystems`, none declares seed `addOns`), so these
 * hand-built manifests are the only coverage:
 *
 *   playback    — implied by requiredSystems OR the seed add-on, and an
 *                 explicit `opts.withPlayback` overrides BOTH (tri-state).
 *   staff-admin — implied by requiredSystems only.
 *   authz       — seed add-on ONLY, deliberately never implied. See the
 *                 rationale at resolve.ts's `withAuthz` derivation: the flow
 *                 path builds no authz overlay, so admitting authz-sync
 *                 because a flow merely names it launches it with an empty
 *                 OPENFGA_STORE_ID against FGA_ENABLED=false — misconfigured
 *                 but reported as up.
 *
 * `admitsOptional` is a GATE, not an injector: it filters `requested`, so a
 * service must be named in `requiredSystems` to be observable in the closure
 * at all. Each case below therefore names the service AND varies the gate.
 */

import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../load.js';
import { resolveFlow } from '../resolve.js';
import type { FlowManifest } from '../types.js';

const SPA = {
  id: 'saga-dash',
  system: 'saga-dash',
  repoEnvVar: 'SAGA_DASH',
  defaultRepoSubpath: 'saga-dash',
  appDir: 'apps/web/dash',
  e2eDir: 'apps/web/dash/e2e',
  playwrightConfig: 'playwright.stack.config.ts',
};

/** A single-stage flow naming `systems`, optionally carrying a seed add-on. */
function flowNaming(systems: string[], addOns?: string[]): FlowManifest {
  return parseFlowManifest(
    JSON.stringify({
      schemaVersion: 1,
      spa: SPA,
      flows: [
        {
          name: 'solo',
          description: 'names an optional service directly',
          lanes: ['stack'],
          progressive: false,
          ...(addOns !== undefined
            ? { seed: { profile: 'roster', reset: true, addOns } }
            : {}),
          stages: [
            { id: 'only', project: 'only', spec: 'only.e2e.test.ts', requiredSystems: systems },
          ],
        },
      ],
    }),
  );
}

describe('authz is admitted by the seed add-on ONLY, never implied', () => {
  it('drops authz-sync when a flow merely names it', () => {
    const r = resolveFlow(flowNaming(['authz-sync']), 'solo');
    expect(r.requiredSystems).toContain('authz-sync');
    expect(r.closure.services).not.toContain('authz-sync');
  });

  it('admits authz-sync when the seed layers the authz add-on', () => {
    const r = resolveFlow(flowNaming(['authz-sync'], ['authz']), 'solo');
    expect(r.closure.services).toContain('authz-sync');
  });
});

describe('playback is implied by requiredSystems, unlike authz', () => {
  it('admits transcripts-api when a flow names it, with no seed add-on', () => {
    const r = resolveFlow(flowNaming(['transcripts-api']), 'solo');
    expect(r.closure.services).toContain('transcripts-api');
  });

  it('admits it via the seed add-on too', () => {
    const r = resolveFlow(flowNaming(['transcripts-api'], ['playback']), 'solo');
    expect(r.closure.services).toContain('transcripts-api');
  });

  // The tri-state: `opts.withPlayback ?? (implied || seed)`. An explicit false
  // SUPPRESSES both derivations — a plain set-union cannot express "forced off".
  it('explicit withPlayback:false suppresses the implied path', () => {
    const r = resolveFlow(flowNaming(['transcripts-api']), 'solo', { withPlayback: false });
    expect(r.closure.services).not.toContain('transcripts-api');
  });

  it('explicit withPlayback:false suppresses the seed add-on too', () => {
    const r = resolveFlow(flowNaming(['transcripts-api'], ['playback']), 'solo', {
      withPlayback: false,
    });
    expect(r.closure.services).not.toContain('transcripts-api');
  });

  it('explicit withPlayback:true admits it with neither implication nor add-on', () => {
    const r = resolveFlow(flowNaming(['transcripts-api', 'sis-api']), 'solo', {
      withPlayback: true,
    });
    expect(r.closure.services).toContain('transcripts-api');
  });
});

describe('staff-admin is implied by requiredSystems', () => {
  it('admits staff-admin-bff when a flow names it', () => {
    const r = resolveFlow(flowNaming(['staff-admin-bff']), 'solo');
    expect(r.closure.services).toContain('staff-admin-bff');
  });
});

describe('a prerequisite inherits playback but RE-DERIVES the other families', () => {
  // The recursive resolveFlow call forwards only `withPlayback`, already
  // resolved to a concrete boolean. So the prerequisite INHERITS playback (it
  // cannot derive its own) while staff-admin and authz are re-derived from its
  // OWN requiredSystems and seed. Threading a whole FeatureSet into that call
  // would collapse the distinction.
  const chained = (): FlowManifest =>
    parseFlowManifest(
      JSON.stringify({
        schemaVersion: 1,
        spa: SPA,
        flows: [
          {
            name: 'producer',
            description: 'prerequisite naming its own optional service',
            lanes: ['stack'],
            progressive: true,
            stages: [
              {
                id: 'one',
                project: 'stage-1',
                spec: 'one.e2e.test.ts',
                requiredSystems: ['staff-admin-bff', 'transcripts-api'],
              },
            ],
          },
          {
            name: 'consumer',
            description: 'names no optional service of its own',
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

  it("re-derives the prerequisite's staff-admin from its own requiredSystems", () => {
    const r = resolveFlow(chained(), 'consumer');
    expect(r.closure.services).not.toContain('staff-admin-bff');
    expect(r.prerequisite?.closure.services).toContain('staff-admin-bff');
  });

  it("propagates the parent's explicit withPlayback:false into the prerequisite", () => {
    const r = resolveFlow(chained(), 'consumer', { withPlayback: false });
    expect(r.prerequisite?.closure.services).not.toContain('transcripts-api');
  });

  // The parent resolves `withPlayback` to a concrete boolean before recursing,
  // so the prerequisite always receives an explicit value and its own
  // `?? (implied || seed)` never runs. A prerequisite therefore CANNOT imply
  // playback from its own requiredSystems — unlike staff-admin above. The
  // consumer names no playback service, so the prerequisite is handed false
  // and drops transcripts-api despite naming it.
  it('cannot imply playback itself — the parent always decides', () => {
    const r = resolveFlow(chained(), 'consumer');
    expect(r.prerequisite?.requiredSystems).toContain('transcripts-api');
    expect(r.prerequisite?.closure.services).not.toContain('transcripts-api');
  });

  it("inherits the parent's explicit withPlayback:true", () => {
    const r = resolveFlow(chained(), 'consumer', { withPlayback: true });
    expect(r.prerequisite?.closure.services).toContain('transcripts-api');
  });
});
