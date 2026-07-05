/**
 * Named seed DATASETS + cross-system SCENARIOS (saga-ed/soa#221, multi-seed
 * composition — `claude/projects/gh_214/multiseed-research.md` Option C, with
 * Option A as the transport for the coupled core).
 *
 * Two layers, per the research recommendation:
 *  - the MECHANICAL unit is per-system: `{system → dataset}` reaches individual
 *    seed steps as a `SEED_DATASET=<name>` env var stamped onto a compose-time
 *    CLONE of the frozen registry step (the house `SEED_DEMO_ONLY` pattern —
 *    the repo's single `db:seed` branches on the var);
 *  - the AUTHORED unit is a SCENARIO: a named, internally-coherent set of
 *    per-system datasets that must be applied together (the scheduling/programs/
 *    sessions triad derives ids from the same positional catalogs, so selecting
 *    `ab-topology` for scheduling but not programs is not a valid state).
 *
 * Dataset is IDENTITY (which fixture); profile stays QUANTITY (how much) — the
 * axes are orthogonal, so a dataset never changes WHICH steps are selected, only
 * what the selected steps seed. Coherence (a scenario cannot be half-applied) is
 * enforced by `composeSeedPlan` after the gates run.
 *
 * PURE: types + frozen data + resolution helpers; zero IO.
 */

import type { ServiceId } from '../manifest/index.js';
import type { SeedStep } from './types.js';

/** Per-system named-dataset selection (identity axis; `profile` is quantity). */
export interface SystemSeedDataset {
  system: ServiceId;
  dataset: string;
}

/**
 * Env var stamped onto a cloned seed step so the owning repo's `db:seed` can
 * branch to the named dataset (exact precedent: `SEED_DEMO_ONLY`).
 */
export const SEED_DATASET_VAR = 'SEED_DATASET';

/** The closed set of scenario names (grow append-only, like the seed-id catalogs). */
export const SEED_SCENARIO_NAMES = ['ab-topology'] as const;
export type SeedScenarioName = (typeof SEED_SCENARIO_NAMES)[number];

/**
 * Scenario registry: scenario → the coherent per-system dataset map it expands
 * to. `ab-topology` is the motivating A/B day-type case: programs declares the
 * rotation topology, scheduling mints per-(period,rotation) slots, sessions
 * projects per-rotation — all three read the same append-only id catalogs, so
 * they must move together (multiseed-research §1, §6).
 */
export const SEED_SCENARIOS: Readonly<Record<SeedScenarioName, readonly SystemSeedDataset[]>> =
  Object.freeze({
    'ab-topology': [
      { system: 'programs-api', dataset: 'ab-topology' },
      { system: 'scheduling-api', dataset: 'ab-topology' },
      { system: 'sessions-api', dataset: 'ab-topology' },
    ],
  });

/** A dataset/scenario selection that cannot compose into a coherent plan. */
export class SeedDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedDatasetError';
  }
}

/**
 * Resolve `scenario` ∪ explicit `datasets` into ONE per-system dataset map.
 * The scenario expands first; explicit entries then merge on top. Two entries
 * naming DIFFERENT datasets for the same system conflict (there is one
 * `SEED_DATASET` var per step) — that is an authoring error, not a merge.
 */
export function resolveDatasetMap(sel: {
  scenario?: SeedScenarioName;
  datasets?: readonly SystemSeedDataset[];
}): Map<ServiceId, string> {
  const map = new Map<ServiceId, string>();

  const merge = (entry: SystemSeedDataset, source: string): void => {
    const existing = map.get(entry.system);
    if (existing !== undefined && existing !== entry.dataset) {
      throw new SeedDatasetError(
        `conflicting datasets for ${entry.system}: '${existing}' vs '${entry.dataset}' (${source})`,
      );
    }
    map.set(entry.system, entry.dataset);
  };

  if (sel.scenario !== undefined) {
    const expansion = SEED_SCENARIOS[sel.scenario];
    if (expansion === undefined) {
      throw new SeedDatasetError(
        `unknown seed scenario '${sel.scenario}' — known: ${SEED_SCENARIO_NAMES.join(', ')}`,
      );
    }
    for (const entry of expansion) merge(entry, `scenario '${sel.scenario}'`);
  }
  for (const entry of sel.datasets ?? []) merge(entry, 'datasets');

  return map;
}

/**
 * Render a plan step id for humans, suffixed `[SEED_DATASET=<name>]` when a
 * dataset was stamped onto it — shared by the `stack seed --dry-run` and
 * `e2e run --dry-run` printers so the two views cannot drift.
 */
export function seedStepLabel(step: SeedStep): string {
  const vars = step.env.kind === 'dotenv' ? undefined : step.env.vars;
  const dataset = vars?.[SEED_DATASET_VAR];
  return dataset === undefined ? step.id : `${step.id} [${SEED_DATASET_VAR}=${dataset}]`;
}
