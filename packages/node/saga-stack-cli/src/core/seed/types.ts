/**
 * Canonical seed contract (plan §4.1, saga-ed/soa#214).
 *
 * There is exactly ONE `SeedStep` and ONE `SeedPlan` for the whole CLI. The
 * flow layer's `SeedSelection` *composes into* this contract (`composeSeedPlan`)
 * rather than defining a parallel shape.
 *
 * This module is PURE: types only, zero IO. `ServiceId`/`DbId` are imported from
 * the manifest (the single source of truth) — never redeclared here. Connection
 * data (`DATABASE_URL`, owner role/pw, `POSTGRES_*`) is DERIVED from the
 * manifest's `DatabaseDef` in `profiles.ts`, not hardcoded in this contract.
 */

import type { DbId, ServiceId } from '../manifest/index.js';

/**
 * Per-system seed override (plan §4.1 / §5, M5). Seeds ONE system's steps at a
 * (possibly heavier) profile, unioned on top of the base `profile`. Lets a
 * single flow seed e.g. `sessions-api` + `programs-api` at `full` while the rest
 * stay at `roster`, without dragging the whole stack to `full`. Additive only —
 * use `only`/`exclude` to NARROW which systems/steps run.
 */
export interface SystemSeedOverride {
  system: ServiceId;
  profile: SeedProfile;
}

/** Base seed profiles (plan §4.1). `roster` is minimal; `full` adds programs+content. */
export type SeedProfile = 'roster' | 'full';

/** Orthogonal add-ons layered on top of a profile (plan §4.1). */
export type SeedAddOn = 'playback' | 'qtf';

/**
 * How a seed step's environment is supplied.
 *  - `dotenv`       — load the owning repo's dotenv file (e.g. `.env.local`), the
 *                     pattern iam's `db:seed` uses to pick up PII_DEK/HMAC keys.
 *  - `inline`       — a single explicit override (typically `DATABASE_URL`),
 *                     forcing the mesh :5432 connection (programs/sessions/content).
 *  - `inline-multi` — the multi-var `POSTGRES_*` set the playback apps read
 *                     (host/port/database/username/password/instance).
 *
 * `inline` and `inline-multi` are structurally identical (a var bag) but kept as
 * distinct kinds so the runtime adapter and `--dry-run` output can render the
 * two up.sh seeding idioms faithfully.
 */
export type SeedEnv =
  | { kind: 'dotenv'; dotenvPath: string }
  | { kind: 'inline'; vars: Record<string, string> }
  | { kind: 'inline-multi'; vars: Record<string, string> };

/**
 * One canonical seed step. Mirrors a single `seed_*` function in up.sh
 * (`~1610-1714`). `databases` gates the snapshot-skip; `requiresServiceUp`
 * partitions offline vs online (post-launch) execution.
 */
export interface SeedStep {
  /** e.g. 'iam' | 'programs' | 'sessions' | 'qtf-demo'. Registry keys are `SeedStepRef`; nested optional substeps use free-form ids. */
  id: string;
  /** Owning service — gates partial-stack drop + snapshot-skip. */
  service: ServiceId;
  /** DBs this step writes; gates the snapshot-skip (see `composeSeedPlan`). */
  databases: DbId[];
  /** Repo-relative working dir (joined to the owning repo root at launch). */
  cwd: string;
  /** Command argv (e.g. `['pnpm', 'db:seed']`). */
  command: string[];
  /** How the step's env is supplied (connection data derived from the manifest). */
  env: SeedEnv;
  /** Non-empty ⇒ the step is `online` (deferred until these services are up). */
  requiresServiceUp: ServiceId[];
  /** Self-guarding tail steps (content's demo-polls / legacy-poll), always `failureMode:'warn'`. */
  optionalSteps?: SeedStep[];
  /** `fatal` aborts the seed run; `warn` logs and continues. */
  failureMode: 'fatal' | 'warn';
}

/** Why a selected step was dropped from the plan. */
export interface SkipNote {
  /** The dropped step's id. */
  id: string;
  service: ServiceId;
  /**
   *  - `service-inactive` — the service is not in the active (closure) stack.
   *  - `service-restored` — the service was fully restored from a snapshot
   *                         (all its DBs), so scratch `db:seed` would clash.
   */
  reason: 'service-inactive' | 'service-restored';
  /** Human-readable detail for `--dry-run` / `emit()`. */
  detail: string;
}

/** The composed seed plan: offline (pre-launch) + online (post-launch) batches + skips. */
export interface SeedPlan {
  offline: SeedStep[];
  online: SeedStep[];
  skipped: SkipNote[];
}

/**
 * Per-flow / per-command seed request. Composes into a `SeedPlan` via
 * `composeSeedPlan`. `flows.json` authors supply this (validated by the zod
 * `seedSelectionSchema` in `core/flow/types.ts`).
 */
export interface SeedSelection {
  /** Base profile applied to EVERY active system unless overridden per-system. */
  profile: SeedProfile;
  /** Whether the runner should `reset` before seeding (runner concern; carried for the flow contract). */
  reset?: boolean;
  /** Orthogonal add-ons (`--add playback,qtf`). */
  addOns?: SeedAddOn[];
  /**
   * Per-system profile overrides (plan §4.1 / §5, M5): seed THESE systems at a
   * heavier profile, unioned on top of the base `profile`. Absent ⇒ the single
   * global `profile` governs every system (the M4 shape — unchanged for M4
   * callers). This is the "which systems seed at which profile" knob a flow's
   * `seed` block authors; `only`/`exclude` still narrow the result.
   */
  perSystem?: SystemSeedOverride[];
  /** Restrict to steps whose service is in this set (`stack seed --only <svc,…>`). */
  only?: ServiceId[];
  /** Drop these step ids (`stack seed --exclude <id,…>`). */
  exclude?: string[];
}
