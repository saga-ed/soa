/**
 * `core/flow` barrel (plan §5, saga-ed/soa#214).
 *
 * Re-exports the `flows.json` schema + inferred types (M0), the real PURE
 * `resolveFlow` + `ResolvedFlow` shape (M5, `./resolve.js`), the built-in SPA
 * registry (`./spa-registry.js`), the PURE flow-discovery path resolution
 * (`./discover.js`), and the centralized date env / e2e date-kit (`./env.js`,
 * `./e2e-kit.js`). The fs lookup that reads + zod-parses a discovered
 * `flows.json` is a thin runtime helper (`runtime/flows.ts`), keeping this whole
 * sub-tree IO-free.
 *
 * PURE: types + zod schema re-exports + pure functions only.
 */

export {
  flowDefSchema,
  flowLaneSchema,
  flowManifestSchema,
  prerequisiteSchema,
  seedSelectionSchema,
  serviceIdSchema,
  spaDescriptorSchema,
  stageDefSchema,
} from './types.js';
export type {
  FlowDef,
  FlowManifest,
  Prerequisite,
  SpaDescriptor,
  StageDef,
} from './types.js';

// M5 centralized date env (the Monday-flake fix) + the stable e2e date-kit
// surface (plan §5.5). `computeEnv` is the CLI-authoritative injector; `e2e-kit`
// re-exports the pure helpers for env-first SPA specs / the future package.
export { computeEnv } from './env.js';
export {
  ENV_OCCURRENCE_DATE,
  ENV_TERM_START,
  ENV_TERM_END,
  fmtLocal,
  mondayOfWeekOf,
  occurrenceDate,
  todayOrNextWeekday,
} from './e2e-kit.js';

export { resolveFlow } from './resolve.js';
export type { ResolvedFlow, ResolvedPlaywright, ResolveFlowOptions } from './resolve.js';

// M14 stage checkpoints — pure identity + compatibility (plan 11 §1-§2).
export {
  CHECKPOINT_MAX_AGE_DAYS,
  checkpointFixtureId,
  evaluateCheckpoint,
  stagePrefixHash,
} from './checkpoint.js';
export type { CheckpointExpectation, CheckpointVerdict } from './checkpoint.js';

export { knownSpaIds, lookupSpa, SPA_REGISTRY } from './spa-registry.js';

export {
  flowsCandidatePaths,
  flowsJsonPath,
  parseFlowRef,
  resolveRepoRoot,
  splitSpaPaths,
} from './discover.js';
export type { DiscoverInput, EnvLookup, FlowRef } from './discover.js';
