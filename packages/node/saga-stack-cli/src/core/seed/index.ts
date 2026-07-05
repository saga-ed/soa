/**
 * `core/seed` barrel — the canonical seed contract + profiles + planner
 * (plan §4, saga-ed/soa#214). PURE: re-exports types and pure functions only.
 */

export type {
  SeedAddOn,
  SeedEnv,
  SeedPlan,
  SeedProfile,
  SeedSelection,
  SeedStep,
  SkipNote,
} from './types.js';
export {
  ADDON_STEPS,
  buildSeedRegistry,
  PROFILE_STEPS,
  SEED_RUN_ORDER,
  SEED_STEPS,
} from './profiles.js';
export type { SeedStepId } from './profiles.js';
export { composeSeedPlan } from './compose-seed-plan.js';
export {
  resolveDatasetMap,
  SEED_DATASET_VAR,
  SEED_SCENARIO_NAMES,
  SEED_SCENARIOS,
  SeedDatasetError,
  seedStepLabel,
} from './datasets.js';
export type { SeedScenarioName, SystemSeedDataset } from './datasets.js';
