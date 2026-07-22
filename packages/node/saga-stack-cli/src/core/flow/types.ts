/**
 * `flows.json` schema (plan §5.1, saga-ed/soa#214) — the ONE external contract
 * authored by SPA repos. This is the single place the CLI uses zod+JSON: the
 * service manifest itself stays a frozen TS module, but `flows.json` is authored
 * by third-party SPA repos that must not depend on the CLI's types, so it is
 * validated by zod at load.
 *
 * Converged onto the richer shape: `{ schemaVersion: 1, spa, flows: FlowDef[] }`.
 * The field is `schemaVersion` (not `version`); `flows` is an ARRAY (not a map).
 *
 * PURE: schema declarations + inferred types only; zod parsing is IO-free.
 */

import { z } from 'zod';
import type { ServiceId } from '../manifest/index.js';
import { SEED_SCENARIO_NAMES } from '../seed/datasets.js';
import type { SeedSelection } from '../seed/index.js';

/**
 * The closed set of `ServiceId` literals, as a zod enum, so a typo in a
 * `flows.json` `requiredSystems`/`system` is a validation error. Kept in sync
 * with the manifest union by the compile-time guard below.
 */
const SERVICE_IDS = [
  'iam-api',
  'sis-api',
  'programs-api',
  'scheduling-api',
  'sessions-api',
  'content-api',
  'ads-adm-api',
  'saga-dash',
  'connect-api',
  'connect-web',
  'rtsm-api',
  'coach-api',
  'coach-web',
  'transcripts-api',
  'insights-api',
  'chat-api',
  'authz-sync',
  'authz-api',
] as const;

// Compile guard: every literal above must be a real ServiceId (catches typos /
// stale ids if the manifest union changes).
const _serviceIdsAreServiceIds: readonly ServiceId[] = SERVICE_IDS;
void _serviceIdsAreServiceIds;

export const serviceIdSchema = z.enum(SERVICE_IDS);

/** Lanes a flow can run on (e2e `--lane <stack|sandbox>`; tunnel reserved). */
export const flowLaneSchema = z.enum(['stack', 'sandbox', 'tunnel']);

const seedProfileSchema = z.enum(['roster', 'full']);
const seedAddOnSchema = z.enum(['playback', 'qtf', 'authz']);

/**
 * Seed selection authored inline in a flow/stage. Structurally compatible with
 * the canonical `SeedSelection` (core/seed) — the compile guard below asserts it.
 */
export const seedSelectionSchema = z.object({
  profile: seedProfileSchema,
  reset: z.boolean().optional(),
  addOns: z.array(seedAddOnSchema).optional(),
  // Per-system profile overrides (plan §5): the "which systems seed at which
  // profile" knob, authored inline in a flow/stage `seed` block. An ARRAY (not
  // an enum-keyed record) so the zod-inferred type is structurally IDENTICAL to
  // the canonical `SystemSeedOverride[]` — the compile guard below asserts it.
  perSystem: z.array(z.object({ system: serviceIdSchema, profile: seedProfileSchema })).optional(),
  only: z.array(serviceIdSchema).optional(),
  exclude: z.array(z.string()).optional(),
  // #221 multi-seed: named cross-system scenario + per-system dataset overrides
  // (the IDENTITY axis — see core/seed/datasets.ts). Mirrored from the canonical
  // `SeedSelection` in the SAME change (the compile guard below).
  scenario: z.enum(SEED_SCENARIO_NAMES).optional(),
  datasets: z
    .array(z.object({ system: serviceIdSchema, dataset: z.string().min(1) }))
    .optional(),
});

// Compile guard: the canonical SeedSelection must satisfy this schema's shape.
const _seedSelectionInSync: z.infer<typeof seedSelectionSchema> = {} as SeedSelection;
void _seedSelectionInSync;

/** Describes the SPA that owns this `flows.json` (plan §5.1). */
export const spaDescriptorSchema = z.object({
  /** SPA id (e.g. 'saga-dash' | 'connectv3'). */
  id: z.string(),
  /** The SPA's frontend service in the manifest — fed to the closure (`spa.system`). */
  system: serviceIdSchema,
  /** Env var that overrides the repo root (e.g. 'SAGA_DASH'); falls back to `$DEV/<default>`. */
  repoEnvVar: z.string(),
  /** Default repo subpath under `$DEV` when `repoEnvVar` is unset. */
  defaultRepoSubpath: z.string(),
  /** Dir Playwright runs in (repo-relative). */
  appDir: z.string(),
  /** Dir holding `flows.json` + specs (repo-relative). */
  e2eDir: z.string(),
  /** Playwright config path passed via `--config` (repo-relative). */
  playwrightConfig: z.string(),
});

/** A single Playwright stage within a flow (plan §5.1). */
export const stageDefSchema = z.object({
  id: z.string(),
  /** Optional human/ordinal phase label (`e2e --phase <name|n>`). */
  phase: z.union([z.string(), z.number()]).optional(),
  /** Playwright project (e.g. 'stage-1'). */
  project: z.string(),
  /** Spec file the stage runs. */
  spec: z.string(),
  /** Services this stage needs up — unioned into the closure. */
  requiredSystems: z.array(serviceIdSchema),
  /** Optional per-stage seed override. */
  seed: seedSelectionSchema.optional(),
  /** Optional Playwright grep tags (e.g. '@interactive'). */
  tags: z.array(z.string()).optional(),
});

/** A prerequisite flow that must run (partially) before this one (plan §5.2). */
export const prerequisiteSchema = z.object({
  flow: z.string(),
  throughStage: z.string(),
});

/** A named flow (plan §5.1). */
export const flowDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Lanes this flow supports. */
  lanes: z.array(flowLaneSchema),
  /** Progressive flows chain stage deps `1..N`; non-progressive run a single stage. */
  progressive: z.boolean(),
  /** Ordered stages (at least one). */
  stages: z.array(stageDefSchema).min(1),
  /** Optional prerequisite flow (e.g. connect-session ⇐ journey through 'schedule'). */
  prerequisite: prerequisiteSchema.optional(),
  /** Held in the foreground (window/AV holds) rather than headless-by-default. */
  foreground: z.boolean().optional(),
  /** Audio/video flow (connect-session). */
  av: z.boolean().optional(),
  /** Flow-level seed selection. */
  seed: seedSelectionSchema.optional(),
  /** Extra env injected for every stage of this flow. */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * soa#327: persona emails whose devLogin-ability DEFINES "settled" for the
   * state THIS flow produces — declared on the PRODUCING flow (journey), read
   * by the bake quiescence barrier and the tunnel post-restore preflight.
   * These personas are created by the flow itself (roster-sync during stage
   * replay), NOT by `stack seed` — a seed-alias probe (dev@saga.org) would
   * false-negative because its pii row exists even in a torn dump. Keep in
   * sync with the SPA's spec constants (saga-dash: TUTOR_EMAIL in
   * e2e/interactive/connect-session.e2e.test.ts). Deliberately EXCLUDED from
   * `stagePrefixHash` — declaring a probe persona does not change the state
   * the stages produce, so it must not invalidate existing checkpoints.
   */
  settlePersonas: z.array(z.string().min(1)).optional(),
});

/** Top-level `flows.json` document (plan §5.1). */
export const flowManifestSchema = z.object({
  schemaVersion: z.literal(1),
  spa: spaDescriptorSchema,
  flows: z.array(flowDefSchema),
});

export type SpaDescriptor = z.infer<typeof spaDescriptorSchema>;
export type StageDef = z.infer<typeof stageDefSchema>;
export type Prerequisite = z.infer<typeof prerequisiteSchema>;
export type FlowDef = z.infer<typeof flowDefSchema>;
export type FlowManifest = z.infer<typeof flowManifestSchema>;
