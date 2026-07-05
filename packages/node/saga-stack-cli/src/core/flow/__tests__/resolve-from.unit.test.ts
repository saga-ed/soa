/**
 * M14 `fromPhase` resolution: the from..through window, the surfaced
 * predecessor/producing-stages checkpoint block, forced reset=false, and the
 * guard errors (non-progressive, prerequisite-bearing, from-after-through).
 * Driven off the bundled example flows.json like resolve.unit.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlowManifest } from '../load.js';
import { resolveFlow } from '../resolve.js';

// eslint-disable-next-line no-restricted-imports -- test fixture read; production core stays fs-free
const EXAMPLE = fileURLToPath(new URL('../../../../examples/flows/saga-dash.flows.json', import.meta.url));
const manifest = parseFlowManifest(readFileSync(EXAMPLE, 'utf8'), EXAMPLE);

describe('resolveFlow fromPhase (M14)', () => {
  it('windows the stages and surfaces the predecessor + producing prefix', () => {
    const r = resolveFlow(manifest, 'journey', { fromPhase: 'enrollment', throughPhase: 'pods' });
    expect(r.stages.map((s) => s.id)).toEqual(['enrollment', 'pods']);
    expect(r.checkpoint?.predecessor.id).toBe('program');
    expect(r.checkpoint?.predecessorPosition).toBe(2);
    expect(r.checkpoint?.producingStages.map((s) => s.id)).toEqual(['roster', 'program']);
    expect(r.reset).toBe(false); // the restore IS the state source
    // The closure narrows to the WINDOW's requiredSystems (+ spa + iam).
    expect(r.requiredSystems).not.toContain('sis-api'); // only roster needed sis
  });

  it('matches by phase number like --through', () => {
    const r = resolveFlow(manifest, 'journey', { fromPhase: 3 });
    expect(r.stages[0]?.id).toBe('enrollment');
    expect(r.checkpoint?.predecessor.id).toBe('program');
  });

  it('fromPhase at the FIRST stage is a plain run (no checkpoint, full prefix)', () => {
    const r = resolveFlow(manifest, 'journey', { fromPhase: 'roster', throughPhase: 'program' });
    expect(r.checkpoint).toBeUndefined();
    expect(r.stages.map((s) => s.id)).toEqual(['roster', 'program']);
    expect(r.reset).toBe(true); // normal reset+seed applies
  });

  it('rejects --from after --through', () => {
    expect(() => resolveFlow(manifest, 'journey', { fromPhase: 'pods', throughPhase: 'program' })).toThrow(
      /--from must not come after --through/,
    );
  });

  it('rejects a non-progressive flow (connect-session — the progressive guard fires first)', () => {
    expect(() => resolveFlow(manifest, 'connect-session', { fromPhase: 'interactive-connect' })).toThrow(
      /--from requires a progressive flow/,
    );
  });
});
