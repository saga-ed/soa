/**
 * `core/snapshot` barrel — the per-snapshot manifest schema + the three pure
 * planners (plan §4.3, saga-ed/soa#214). PURE: re-exports types, the zod schema,
 * and pure functions only. The command layer consumes these via `core/index.ts`;
 * the dump/restore mechanics live in `runtime/`.
 *
 * Note: the internal `dbId`/`serviceId` zod enums in `manifest.ts` are NOT
 * re-exported (the `serviceIdSchema` name already belongs to `core/flow`).
 */

export {
  CURRENT_SNAPSHOT_SCHEMA_VERSION,
  parseSnapshotManifest,
  safeParseSnapshotManifest,
  serializeSnapshotManifest,
  snapshotDbSchema,
  snapshotFlowBlockSchema,
  snapshotManifestSchema,
} from './manifest.js';
export type { SnapshotDbEntry, SnapshotFlowBlock, SnapshotManifest } from './manifest.js';

export {
  evaluateValidation,
  restorePlan,
  storePlan,
  validatePlan,
} from './plan.js';
export type {
  FileCheck,
  LocalMigrations,
  ObservedFile,
  RestoreDbAction,
  RestoreGuardFailure,
  RestorePlan,
  RestorePlanOptions,
  StoreDbAction,
  StorePlan,
  StorePlanOptions,
  ValidatePlan,
  ValidationFailure,
  ValidationResult,
} from './plan.js';
