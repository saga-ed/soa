/**
 * Named seed datasets + scenarios unit tests (saga-ed/soa#221 multi-seed).
 *
 * `resolveDatasetMap` is the pure resolution step: scenario expansion first,
 * explicit per-system datasets merged on top, with a same-system conflict being
 * an authoring ERROR (one `SEED_DATASET` var per step — never a silent merge).
 *
 * PURE: no docker/pnpm/network.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceId } from '../../manifest/index.js';
import { composeSeedPlan } from '../compose-seed-plan.js';
import {
  resolveDatasetMap,
  SEED_SCENARIO_NAMES,
  SEED_SCENARIOS,
  SeedDatasetError,
  seedStepLabel,
} from '../datasets.js';
import type { SeedScenarioName } from '../datasets.js';

describe('resolveDatasetMap — scenario expansion', () => {
  it('ab-topology expands to the coupled programs/scheduling/sessions triad', () => {
    const map = resolveDatasetMap({ scenario: 'ab-topology' });
    expect(map.get('programs-api')).toBe('ab-topology');
    expect(map.get('scheduling-api')).toBe('ab-topology');
    expect(map.get('sessions-api')).toBe('ab-topology');
    expect(map.size).toBe(3);
  });

  it('an empty selection resolves to an empty map', () => {
    expect(resolveDatasetMap({}).size).toBe(0);
  });

  it('every registered scenario name expands to a non-empty dataset set', () => {
    for (const name of SEED_SCENARIO_NAMES) {
      expect(SEED_SCENARIOS[name].length).toBeGreaterThan(0);
      expect(resolveDatasetMap({ scenario: name }).size).toBe(SEED_SCENARIOS[name].length);
    }
  });

  it('throws SeedDatasetError on a scenario name outside the registry (runtime guard)', () => {
    expect(() => resolveDatasetMap({ scenario: 'nope' as SeedScenarioName })).toThrow(SeedDatasetError);
  });
});

describe('resolveDatasetMap — explicit datasets + merge', () => {
  it('datasets alone map each named system', () => {
    const map = resolveDatasetMap({
      datasets: [{ system: 'content-api', dataset: 'qtf-demo' }],
    });
    expect(map.get('content-api')).toBe('qtf-demo');
    expect(map.size).toBe(1);
  });

  it('explicit datasets merge ON TOP of a scenario (disjoint system)', () => {
    const map = resolveDatasetMap({
      scenario: 'ab-topology',
      datasets: [{ system: 'content-api', dataset: 'qtf-demo' }],
    });
    expect(map.get('content-api')).toBe('qtf-demo');
    expect(map.get('programs-api')).toBe('ab-topology');
    expect(map.size).toBe(4);
  });

  it('a REDUNDANT (same-name) entry for a scenario system is accepted', () => {
    const map = resolveDatasetMap({
      scenario: 'ab-topology',
      datasets: [{ system: 'programs-api', dataset: 'ab-topology' }],
    });
    expect(map.get('programs-api')).toBe('ab-topology');
    expect(map.size).toBe(3);
  });

  it('a CONFLICTING name for a scenario system throws SeedDatasetError', () => {
    expect(() =>
      resolveDatasetMap({
        scenario: 'ab-topology',
        datasets: [{ system: 'programs-api', dataset: 'other' }],
      }),
    ).toThrow(/conflicting datasets for programs-api.*'ab-topology' vs 'other'/);
  });

  it('two conflicting explicit entries for the same system throw too', () => {
    expect(() =>
      resolveDatasetMap({
        datasets: [
          { system: 'sessions-api', dataset: 'a' },
          { system: 'sessions-api', dataset: 'b' },
        ],
      }),
    ).toThrow(SeedDatasetError);
  });
});

describe('seedStepLabel — shared dry-run printer', () => {
  it('labels a stamped step with [SEED_DATASET=<name>] and leaves plain steps as bare ids', () => {
    const plan = composeSeedPlan(
      { profile: 'full', scenario: 'ab-topology' },
      new Set<ServiceId>(['iam-api', 'sessions-api', 'programs-api', 'scheduling-api']),
      new Set<ServiceId>(),
    );
    const labels = [...plan.offline, ...plan.online].map((s) => seedStepLabel(s));
    expect(labels).toContain('programs [SEED_DATASET=ab-topology]');
    expect(labels).toContain('iam-dev-user'); // unstamped ⇒ bare id
  });
});
