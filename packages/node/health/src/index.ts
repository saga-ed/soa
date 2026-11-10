export {
    mountHealthRoutes,
    buildIdentity,
    type HealthRouter,
    type HealthResponse,
    type MountHealthOptions,
    type BuildIdentity,
    type EnvLike,
} from './health.js';

export {
    mountReadinessRoutes,
    type ReadinessRouter,
    type ReadinessResponse,
    type ProbeResult,
    type MountReadinessOptions,
} from './readiness.js';

export {
    createDbReadiness,
    type DbReadiness,
    type DbReadinessOptions,
    type DbReadinessSnapshot,
} from './db-readiness.js';

export { awaitDbAtBoot, type AwaitDbAtBootOptions } from './db-boot.js';

export { createDrainSignal, type DrainSignal } from './drain.js';

export {
  dep,
  declareDependencies,
  assertManifestComplete,
  registerClient,
  registeredClients,
  clearClientRegistry,
  type AssertManifestOptions,
} from './deep/manifest.js';
export { createDeepReadiness, parseBootMode } from './deep/runner.js';
export { mountDeepReadiness } from './deep/mount.js';
export { createBearerAuthorizer } from './deep/auth.js';
export { classifyError } from './deep/classify.js';
export type {
  AnyDependency,
  BootMode,
  CreateDeepReadinessOptions,
  Criticality,
  DeepReadiness,
  DependencyDeclaration,
  DependencyKind,
  DependencyManifest,
  DependencyReport,
  DependencyScope,
  DependencyState,
  DetailLevel,
  ProbeOutcome,
  ProbeReason,
  ProbeScheduleOptions,
  ReadinessEvent,
  ReadinessReport,
  ReadinessVerdict,
} from './deep/types.js';
export { pgFreshProbe, type PgClientLike, type ProbeFetchLike } from './deep/adapters.js';
