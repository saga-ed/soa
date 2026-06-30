/**
 * `core/flow` barrel + the `resolveFlow` stub (plan §5, saga-ed/soa#214).
 *
 * The full resolver (closure union, prerequisite recursion, env clamp) lands in
 * M5 (§5.4). M0 ships the schema + inferred types + a type-correct stub so the
 * command layer and `core/index.ts` can compile against the final signature.
 *
 * PURE: types + zod schema re-exports + a pure (throwing) stub.
 */

import type { ServiceId } from '../manifest/index.js';
import type { SeedSelection } from '../seed/index.js';
import type { FlowDef, FlowManifest, SpaDescriptor, StageDef } from './types.js';

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

/** Options narrowing which stages of a flow to resolve (progressive `--through`). */
export interface ResolveFlowOptions {
  /** Resolve up to and including this stage id (progressive flows). */
  throughStage?: string;
  /** Run only the terminal stage, stripping Playwright deps (`--stage-only`). */
  stageOnly?: boolean;
}

/**
 * A flow resolved into the inputs the runner needs: the owning SPA, the flow,
 * the selected stages, the union of `requiredSystems` (∪ `spa.system`, fed to
 * `computeClosure`), and the effective seed selection. Surfaced by `--dry-run`.
 */
export interface ResolvedFlow {
  spa: SpaDescriptor;
  flow: FlowDef;
  /** Stages selected for this run (after `throughStage`/`stageOnly`). */
  stages: StageDef[];
  /** Union of selected stages' `requiredSystems` ∪ `{ spa.system, iam-api }`. */
  requiredSystems: ServiceId[];
  /** Effective seed selection (flow-level, possibly overridden per stage). */
  seed?: SeedSelection;
}

/**
 * Resolve a named flow from a loaded `FlowManifest` into a `ResolvedFlow`.
 *
 * TODO(M5, plan §5.4): implement — (1) look up `flowName` (throw on miss);
 * (2) recurse `prerequisite` (mark SKIP_RESET, force headless); (3) select
 * stages up to `throughStage`; (4) union `requiredSystems` ∪ `{spa.system,
 * iam-api}`; (5) merge per-stage seed over the flow seed. M0 is a type-correct
 * placeholder so downstream signatures compile.
 */
export function resolveFlow(
  _manifest: FlowManifest,
  _flowName: string,
  _opts: ResolveFlowOptions = {},
): ResolvedFlow {
  throw new Error('resolveFlow is implemented in M5 (flow runner) — see plan §5.4');
}
