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

describe('resolveFlow toPhase (Plan 13 --to)', () => {
  it('windows UP TO but NOT INCLUDING the target (exclusive end)', () => {
    const r = resolveFlow(manifest, 'journey', { toPhase: 'pods' });
    // pods is stage 4 → run roster..enrollment (stops BEFORE pods).
    expect(r.stages.map((s) => s.id)).toEqual(['roster', 'program', 'enrollment']);
    expect(r.checkpoint).toBeUndefined();
    expect(r.reset).toBe(true); // no --from ⇒ normal reset+seed of the window
    // terminal Playwright project is the LAST run stage, not pods.
    expect(r.playwright.project).toBe('stage-3-enrollment-periods');
  });

  it('matches by phase number like --through', () => {
    const r = resolveFlow(manifest, 'journey', { toPhase: 3 });
    // phase 3 = enrollment → run roster..program.
    expect(r.stages.map((s) => s.id)).toEqual(['roster', 'program']);
  });

  it('--to the FIRST stage = empty window (reset+seed baseline, zero Playwright)', () => {
    const r = resolveFlow(manifest, 'journey', { toPhase: 'roster' });
    expect(r.stages).toEqual([]);
    expect(r.checkpoint).toBeUndefined();
    expect(r.reset).toBe(true); // baseline flow seed still applies
    // Only the SPA + iam are required (the union over zero stages).
    expect(r.requiredSystems).toEqual(['saga-dash', 'iam-api']);
    expect(r.playwright.project).toBe('');
  });

  it('--from X --to Y windows the interior [X, Y) and surfaces the checkpoint', () => {
    const r = resolveFlow(manifest, 'journey', { fromPhase: 'program', toPhase: 'pods' });
    expect(r.stages.map((s) => s.id)).toEqual(['program', 'enrollment']);
    expect(r.checkpoint?.predecessor.id).toBe('roster');
    expect(r.checkpoint?.predecessorPosition).toBe(1);
    expect(r.checkpoint?.producingStages.map((s) => s.id)).toEqual(['roster']);
    expect(r.reset).toBe(false); // the restore IS the state source
  });

  it('--from K --to K = EMPTY window with a checkpoint (restore, run nothing — the hold idiom)', () => {
    const r = resolveFlow(manifest, 'journey', { fromPhase: 'schedule', toPhase: 'schedule' });
    expect(r.stages).toEqual([]);
    // the checkpoint restored is schedule's PREDECESSOR (pods, position 4).
    expect(r.checkpoint?.predecessor.id).toBe('pods');
    expect(r.checkpoint?.predecessorPosition).toBe(4);
    expect(r.reset).toBe(false);
    expect(r.playwright.project).toBe('');
  });

  it('rejects --from AFTER --to (from past the exclusive end)', () => {
    expect(() => resolveFlow(manifest, 'journey', { fromPhase: 'pods', toPhase: 'program' })).toThrow(
      /--from must not come after --to/,
    );
  });

  it('rejects --to together with --through (mutually exclusive)', () => {
    expect(() => resolveFlow(manifest, 'journey', { toPhase: 'pods', throughPhase: 'schedule' })).toThrow(
      /--to and --through are mutually exclusive/,
    );
  });

  it('rejects --to on a non-progressive flow (no interior state)', () => {
    expect(() => resolveFlow(manifest, 'connect-session', { toPhase: 'interactive-connect' })).toThrow(
      /--to requires a progressive flow/,
    );
  });

  it('unknown --to stage → did-you-mean error listing the stages', () => {
    expect(() => resolveFlow(manifest, 'journey', { toPhase: 'nope' })).toThrow(
      /no stage matches --to 'nope'/,
    );
  });

  it('off-by-one: --to <last stage> runs the whole flow except the last stage', () => {
    const r = resolveFlow(manifest, 'journey', { toPhase: 'attendance-personas' });
    expect(r.stages.map((s) => s.id)).toEqual([
      'roster',
      'program',
      'enrollment',
      'pods',
      'schedule',
      'sessions',
      'attendance',
    ]);
  });
});
