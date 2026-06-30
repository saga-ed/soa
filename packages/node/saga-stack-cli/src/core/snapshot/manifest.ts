/**
 * Per-SNAPSHOT manifest schema (plan §4.3, saga-ed/soa#214) — distinct from the
 * service manifest (`core/manifest/`).
 *
 * Every snapshot directory carries one `manifest.json` describing what was
 * captured: the fixture id, the `SEED_PROFILE` it was stored under (drives the
 * restore profile guard), and per-database dump metadata — the DB name, its
 * engine, the role the dump must be restored AS (snapshot invariant #2), the
 * captured `schemaRev` (the `_prisma_migrations` head, used by the restore
 * snapshot-ahead guard; `null` for db-push / mongo DBs that have no migration
 * history), the on-disk dump filename, and its size. `systems` records which
 * services were FULLY captured (all their DBs) so a snapshot can feed the flow
 * layer; `flowId` ties a snapshot to the flow that produced it.
 *
 * This is the SECOND (and last) place the CLI uses zod+JSON: like `flows.json`,
 * a snapshot manifest is an on-disk artifact written by one run and read by a
 * later one (possibly a different CLI version), so it is validated at the
 * boundary. The service manifest itself stays a frozen TS module.
 *
 * PURE: zod schema declarations, inferred types, and IO-free parse/serialize
 * helpers only. No fs/child_process here — the command/runtime layer reads and
 * writes the file; this module just parses/serializes the JSON it is handed.
 */

import { z } from 'zod';
import type { DbId, ServiceId } from '../manifest/index.js';

/** Current snapshot-manifest schema version (bump on any breaking shape change). */
export const CURRENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * The closed set of `DbId` literals, as a zod enum, so a stale/typo'd db name in
 * an on-disk manifest is a parse error. Kept in sync with the manifest union by
 * the compile guard below (mirrors `flow/types.ts`).
 */
const DB_IDS = [
  'iam_local',
  'iam_pii_local',
  'programs',
  'scheduling',
  'sessions',
  'content',
  'sis_db',
  'ads_adm_local',
  'ledger_local',
  'transcripts_local',
  'insights_local',
  'chat_local',
  'connectv3',
] as const;
const _dbIdsAreDbIds: readonly DbId[] = DB_IDS;
void _dbIdsAreDbIds;

/** Same closed `ServiceId` set used by `flow/types.ts` (compile-guarded). */
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
  'transcripts-api',
  'insights-api',
  'chat-api',
] as const;
const _serviceIdsAreServiceIds: readonly ServiceId[] = SERVICE_IDS;
void _serviceIdsAreServiceIds;

const dbIdSchema = z.enum(DB_IDS);
const serviceIdSchema = z.enum(SERVICE_IDS);
const engineSchema = z.enum(['postgres', 'mongo']);

/** Per-database dump metadata recorded in a snapshot manifest. */
export const snapshotDbSchema = z.object({
  /** The captured database (= its real pg/mongo name). */
  db: dbIdSchema,
  engine: engineSchema,
  /** Role the dump must be restored AS (snapshot invariant #2). */
  ownerRole: z.string(),
  /**
   * `_prisma_migrations` head at store time. `null` when there is no migration
   * history to capture — db-push DBs (`iam_pii_local`) and mongo (`connectv3`).
   * The restore snapshot-ahead guard keys off this.
   */
  schemaRev: z.string().nullable(),
  /** Dump file size in bytes (validate gate: must be > 0). */
  sizeBytes: z.number().int().nonnegative().optional(),
  /** Dump filename relative to the snapshot dir (`<db>.dump` / `<db>.archive`). */
  file: z.string().min(1),
});

/** The whole-snapshot manifest. */
export const snapshotManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** Fixture identifier (= snapshot directory name). */
  fixtureId: z.string().min(1),
  /** `SEED_PROFILE` at store time — drives the restore profile guard. */
  profile: z.string(),
  /** ISO timestamp of the store operation. */
  createdAt: z.string().optional(),
  databases: z.array(snapshotDbSchema),
  /** Services whose FULL db set was captured (feeds the flow layer). */
  systems: z.array(serviceIdSchema).optional(),
  /** Flow that produced this snapshot, when stored by an e2e flow. */
  flowId: z.string().optional(),
});

export type SnapshotDbEntry = z.infer<typeof snapshotDbSchema>;
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

/** Parse + validate an unknown JSON value into a `SnapshotManifest` (throws on invalid). */
export function parseSnapshotManifest(json: unknown): SnapshotManifest {
  return snapshotManifestSchema.parse(json);
}

/** Non-throwing parse — for `validate`, which reports a parse failure rather than crashing. */
export function safeParseSnapshotManifest(
  json: unknown,
): z.SafeParseReturnType<unknown, SnapshotManifest> {
  return snapshotManifestSchema.safeParse(json);
}

/** Serialize a `SnapshotManifest` to pretty JSON (re-validated), trailing newline. */
export function serializeSnapshotManifest(m: SnapshotManifest): string {
  return JSON.stringify(snapshotManifestSchema.parse(m), null, 2) + '\n';
}
