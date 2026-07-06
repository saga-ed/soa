/**
 * M14 checkpoint pure layer: fixtureId determinism, prefixHash
 * stability/sensitivity (§2.1 — what invalidates a checkpoint must be
 * auditable), and the compat evaluator's date rules (§2.2) with fixed local
 * Date anchors (mirrors env.unit.test.ts — nothing reads the wall clock).
 */

import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_MAX_AGE_DAYS,
  checkpointFixtureId,
  evaluateCheckpoint,
  stagePrefixHash,
} from '../checkpoint.js';
import type { FlowDef, StageDef } from '../types.js';
import type { SnapshotFlowBlock } from '../../snapshot/manifest.js';

const stage = (id: string, phase: number, extra: Partial<StageDef> = {}): StageDef =>
  ({
    id,
    phase,
    project: `stage-${phase}-${id}`,
    spec: `journey/${id}.e2e.test.ts`,
    requiredSystems: ['programs-api'],
    ...extra,
  }) as StageDef;

const FLOW = {
  name: 'journey',
  lanes: ['stack'],
  progressive: true,
  seed: { reset: true, profile: 'roster' },
  stages: [stage('roster', 1), stage('program', 2), stage('enrollment', 3)],
} as unknown as FlowDef;

const NOW = new Date(2026, 6, 4); // Sat 2026-07-04, local — fixed anchor

const block = (over: Partial<SnapshotFlowBlock> = {}): SnapshotFlowBlock => ({
  spa: 'saga-dash',
  flow: 'journey',
  stageId: 'roster',
  phase: 1,
  prefixHash: stagePrefixHash(FLOW, FLOW.stages.slice(0, 1)),
  seedProfile: 'roster',
  dates: { occurrenceDate: '2026-07-06', termStart: '2026-07-06', termEnd: '2026-08-17' },
  bakedAt: new Date(2026, 6, 3).toISOString(), // yesterday
  ...over,
});

const EXPECT = {
  spaId: 'saga-dash',
  flowName: 'journey',
  stageId: 'roster',
  prefixHash: stagePrefixHash(FLOW, FLOW.stages.slice(0, 1)),
  seedProfile: 'roster',
};

describe('checkpointFixtureId', () => {
  it('is deterministic and phase-keyed', () => {
    expect(checkpointFixtureId('saga-dash', 'journey', FLOW.stages[1]!, 2)).toBe(
      'flow-saga-dash-journey-s2-program',
    );
  });

  it('falls back to the 1-based position when the stage has no phase', () => {
    const s = { ...stage('x', 1) } as StageDef;
    delete (s as { phase?: number }).phase;
    expect(checkpointFixtureId('saga-dash', 'journey', s, 4)).toBe('flow-saga-dash-journey-s4-x');
  });
});

describe('stagePrefixHash (§2.1)', () => {
  it('is stable for byte-identical inputs', () => {
    expect(stagePrefixHash(FLOW, FLOW.stages.slice(0, 2))).toBe(stagePrefixHash(FLOW, FLOW.stages.slice(0, 2)));
  });

  it('changes when the prefix GROWS', () => {
    expect(stagePrefixHash(FLOW, FLOW.stages.slice(0, 1))).not.toBe(stagePrefixHash(FLOW, FLOW.stages.slice(0, 2)));
  });

  it('changes when a producing stage definition changes (spec path)', () => {
    const edited = [stage('roster', 1, { spec: 'journey/roster-v2.e2e.test.ts' })];
    expect(stagePrefixHash(FLOW, edited)).not.toBe(stagePrefixHash(FLOW, FLOW.stages.slice(0, 1)));
  });

  it('changes when the flow seed changes', () => {
    const reseeded = { ...FLOW, seed: { reset: true, profile: 'full' } } as unknown as FlowDef;
    expect(stagePrefixHash(reseeded, FLOW.stages.slice(0, 1))).not.toBe(
      stagePrefixHash(FLOW, FLOW.stages.slice(0, 1)),
    );
  });

  it('is INSENSITIVE to non-producing fields (downstream stages, flow lanes)', () => {
    const rebranded = { ...FLOW, lanes: ['stack', 'sandbox'] } as unknown as FlowDef;
    expect(stagePrefixHash(rebranded, FLOW.stages.slice(0, 1))).toBe(stagePrefixHash(FLOW, FLOW.stages.slice(0, 1)));
  });
});

describe('evaluateCheckpoint (§2.2)', () => {
  it('a fresh matching checkpoint is OK', () => {
    const v = evaluateCheckpoint(block(), EXPECT, NOW);
    expect(v).toEqual({ ok: true, violations: [], warnings: [] });
  });

  it('no flow block = not a checkpoint (violation)', () => {
    const v = evaluateCheckpoint(undefined, EXPECT, NOW);
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatch(/no stage-checkpoint provenance/);
  });

  it('identity + prefixHash + seed-profile mismatches are violations', () => {
    expect(evaluateCheckpoint(block({ stageId: 'program' }), EXPECT, NOW).violations[0]).toMatch(/identity mismatch/);
    expect(evaluateCheckpoint(block({ prefixHash: 'deadbeef' }), EXPECT, NOW).violations[0]).toMatch(
      /prefixHash mismatch/,
    );
    expect(evaluateCheckpoint(block({ seedProfile: 'full' }), EXPECT, NOW).violations[0]).toMatch(
      /seed profile mismatch/,
    );
  });

  it(`the >${CHECKPOINT_MAX_AGE_DAYS}-day cliff violates; staleOk downgrades to a warning`, () => {
    const old = block({ bakedAt: new Date(2026, 5, 20).toISOString() }); // 14 days before NOW
    const refused = evaluateCheckpoint(old, EXPECT, NOW);
    expect(refused.ok).toBe(false);
    expect(refused.violations[0]).toMatch(/days old/);

    const allowed = evaluateCheckpoint(old, EXPECT, NOW, true);
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings[0]).toMatch(/stale-ok override/);
  });

  it('exactly-at-the-cliff is still fresh (boundary)', () => {
    const at = block({ bakedAt: new Date(2026, 5, 27).toISOString() }); // 7 days before NOW
    expect(evaluateCheckpoint(at, EXPECT, NOW).ok).toBe(true);
  });

  it('an OLD occurrence date trips the cliff even with a fresh bakedAt (re-bake laundering)', () => {
    const laundered = block({
      dates: { occurrenceDate: '2026-06-01', termStart: '2026-06-01', termEnd: '2026-07-13' }, // 33d before NOW
    });
    const v = evaluateCheckpoint(laundered, EXPECT, NOW);
    expect(v.ok).toBe(false);
    expect(v.violations[0]).toMatch(/oldest of bakedAt\/occurrenceDate/);
  });

  it('a FUTURE occurrence date (weekday clamp) never ages the checkpoint', () => {
    const clamped = block({
      dates: { occurrenceDate: '2026-07-06', termStart: '2026-07-06', termEnd: '2026-08-17' }, // next Monday
    });
    expect(evaluateCheckpoint(clamped, EXPECT, NOW).ok).toBe(true);
  });

  it('SPA HEAD drift is WARN-only (§2.3)', () => {
    const v = evaluateCheckpoint(
      block({ spaHead: { sha: 'aaaaaaaaaaaa', dirty: false } }),
      { ...EXPECT, currentSpaHead: 'bbbbbbbbbbbb' },
      NOW,
    );
    expect(v.ok).toBe(true);
    expect(v.warnings[0]).toMatch(/SPA checkout moved/);
  });
});
