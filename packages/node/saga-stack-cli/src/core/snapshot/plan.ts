/**
 * Pure snapshot planners (plan §4.3, saga-ed/soa#214) — the brains behind
 * `stack snapshot store|restore|validate`.
 *
 * These are the PURE half of the native snapshot fast-path. They decide WHICH
 * databases to dump, WHICH to restore (and whether two guards permit it), and
 * WHICH structural checks `validate` must perform — all as plain data, driven
 * off OUR service manifest's `DatabaseDef`. The proven dump/restore mechanics
 * (pg_dump -F c, pg_restore --clean --if-exists streamed via stdin, mongodump
 * --archive, redis flush) are ported from mesh-fixture-cli but live in
 * `runtime/` (the only place a process is spawned); here we only plan.
 *
 * The 6→10-pg + mongo extension lives ENTIRELY in the manifest-derived db set:
 * mesh-fixture-cli hardcoded 6 pg DBs in `SAGA_MESH_DATABASES`; we drive the set
 * off `manifest.databases`, so all 10 pg app DBs (incl. `content`, `coach_api` +
 * `ledger_local`) plus the `connectv3` mongo DB are covered, and the optional
 * playback trio is admitted only behind `--with-playback`.
 *
 * INVARIANT (plan hard constraint): zero IO. `localMigrations` (db → known local
 * migration ids) and observed file stats are INPUTS supplied by the command /
 * runtime layer; nothing here touches fs, child_process, docker, or the network.
 */

import type { DatabaseDef, DbId, Engine, Manifest, ServiceId } from '../manifest/index.js';
import type { SnapshotManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Shared manifest-derived helpers (pure).
// ---------------------------------------------------------------------------

/** Mesh container that hosts a given engine (postgres → 'postgres', mongo → 'connect-mongo'). */
function containerFor(engine: Engine, m: Manifest): string {
  const meshId = engine === 'mongo' ? 'connect-mongo' : 'postgres';
  return m.mesh[meshId].container;
}

/** Dump filename for a db: pg uses `-F c` custom format `.dump`; mongo uses `--archive` `.archive`. */
function dumpFileFor(db: DbId, engine: Engine): string {
  return engine === 'mongo' ? `${db}.archive` : `${db}.dump`;
}

/**
 * `schemaRev` is captured only for DBs with a prisma MIGRATION HISTORY. Skip
 * db-push DBs (`iam_pii_local`: `prisma db push`, no `_prisma_migrations` head
 * to read) and mongo (`connectv3`: schemaless). This is the single predicate
 * that drives BOTH the store-time capture and the restore snapshot-ahead guard.
 */
function hasMigrationHistory(def: DatabaseDef): boolean {
  return def.engine === 'postgres' && def.migrate?.cmd !== 'prisma db push';
}

/** Build db → owning ServiceId (first service whose `databases` includes the db). */
function ownerServiceOf(m: Manifest): Map<DbId, ServiceId> {
  const owner = new Map<DbId, ServiceId>();
  for (const svc of Object.values(m.services)) {
    for (const db of svc.databases) if (!owner.has(db)) owner.set(db, svc.id);
  }
  return owner;
}

/**
 * A db is "optional" when its owning service is `optional:true` — the playback
 * trio (owned by transcripts-api/insights-api/chat-api) or authz_sync_local/
 * openfga (owned by authz-sync). Name kept for the playback-only pre-authz
 * history; despite the name it is ownership-generic (`svcId ? optional : false`).
 */
function isPlaybackDb(db: DbId, m: Manifest, owner: Map<DbId, ServiceId>): boolean {
  const svcId = owner.get(db);
  return svcId ? m.services[svcId].optional : false;
}

/** Whether an optional db's owning service is specifically `authz-sync` (vs. playback). */
function isAuthzDb(db: DbId, owner: Map<DbId, ServiceId>): boolean {
  return owner.get(db) === 'authz-sync';
}

/**
 * Services whose ENTIRE db set is contained in `dbSet` (and that own ≥1 db).
 * This is the "fully-restored services" rule both `store` (systems captured) and
 * `restore` (→ `composeSeedPlan(restored)`) use: a service with a partially
 * covered db set is intentionally LEFT OUT (matching up.sh:1727's `restored_db`
 * all-DBs rule), so its scratch `db:seed` is still run.
 */
function fullyCoveredServices(m: Manifest, dbSet: Set<DbId>): ServiceId[] {
  const out: ServiceId[] = [];
  for (const svc of Object.values(m.services)) {
    if (svc.databases.length === 0) continue;
    if (svc.databases.every((db) => dbSet.has(db))) out.push(svc.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/** One database the store pass will dump. */
export interface StoreDbAction {
  db: DbId;
  engine: Engine;
  /** Role the dump preserves / will be restored AS. */
  ownerRole: string;
  /** Mesh container the dump runs against (compose default; runtime may env-override). */
  container: string;
  /** Capture `_prisma_migrations` head into `schemaRev` (false for db-push / mongo). */
  captureSchemaRev: boolean;
  /** Dump filename relative to the snapshot dir. */
  file: string;
}

export interface StorePlanOptions {
  fixtureId: string;
  /** `SEED_PROFILE` to stamp into the snapshot manifest. */
  profile: string;
  /**
   * Scope to exactly these DBs (the command resolves `--only <svc,…>` →
   * `computeClosure().databases` and passes them here). When set, it fully
   * determines the db set and `withPlayback` is ignored.
   */
  only?: DbId[];
  /** Include the optional playback trio (transcripts/insights/chat). Ignored when `only` is set. */
  withPlayback?: boolean;
  /** Include the optional authz DBs (openfga/authz_sync_local). Ignored when `only` is set. */
  withAuthz?: boolean;
}

export interface StorePlan {
  fixtureId: string;
  profile: string;
  /** DBs to dump, in manifest declaration order. */
  databases: StoreDbAction[];
  /** Services whose full db set is captured (→ snapshot manifest `systems`). */
  systems: ServiceId[];
}

/**
 * Decide which databases to dump for a `store`.
 *
 * Default set = ALL manifest DBs except those owned by optional (playback or
 * authz) services — i.e. the 10 pg app DBs + `connectv3` mongo. `--with playback`
 * adds the 3 playback DBs; `--with authz` adds openfga/authz_sync_local. `only`
 * (a resolved closure db set) overrides both and scopes the dump precisely.
 */
export function storePlan(m: Manifest, opts: StorePlanOptions): StorePlan {
  const owner = ownerServiceOf(m);
  const allDbIds = Object.keys(m.databases) as DbId[];

  const onlySet = opts.only ? new Set<DbId>(opts.only) : undefined;
  const selected = allDbIds.filter((db) => {
    if (onlySet) return onlySet.has(db);
    if (isPlaybackDb(db, m, owner)) {
      return isAuthzDb(db, owner) ? (opts.withAuthz ?? false) : (opts.withPlayback ?? false);
    }
    return true;
  });

  const databases: StoreDbAction[] = selected.map((db) => {
    const def = m.databases[db];
    return {
      db,
      engine: def.engine,
      ownerRole: def.ownerRole,
      container: containerFor(def.engine, m),
      captureSchemaRev: hasMigrationHistory(def),
      file: dumpFileFor(db, def.engine),
    };
  });

  const systems = fullyCoveredServices(m, new Set(selected));
  return { fixtureId: opts.fixtureId, profile: opts.profile, databases, systems };
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

/** One database the restore pass will load. */
export interface RestoreDbAction {
  db: DbId;
  engine: Engine;
  /** Role the dump is restored AS (snapshot invariant #2). */
  ownerRole: string;
  container: string;
  /** Dump filename (relative to the snapshot dir) — from the snapshot manifest. */
  file: string;
}

/** A guard that blocks (or warns about) a restore. */
export interface RestoreGuardFailure {
  kind: 'profile-mismatch' | 'snapshot-ahead';
  /** The offending db (snapshot-ahead only). */
  db?: DbId;
  /** Whether `--force` bypasses this guard (profile only; snapshot-ahead is hard). */
  bypassableByForce: boolean;
  message: string;
}

/** db → known LOCAL migration ids (the command reads each migration dir and passes this). */
export type LocalMigrations = Partial<Record<DbId, readonly string[]>>;

export interface RestorePlanOptions {
  /** Bypass the (bypassable) profile guard. */
  force?: boolean;
  /**
   * The LIVE stack's `SEED_PROFILE` (the command reads it from the environment).
   * When provided and it differs from the snapshot's `profile`, the profile
   * guard fires unless `force`. Omit to skip the profile guard (can't compare).
   */
  currentProfile?: string;
}

export interface RestorePlan {
  /** No blocking guard fired — safe to execute. */
  ok: boolean;
  /** Ordered restore actions (manifest declaration order). */
  actions: RestoreDbAction[];
  /** Every guard decision (empty ⇒ clean). A bypassable failure with `force` is omitted. */
  guardFailures: RestoreGuardFailure[];
  /**
   * Services FULLY restored by this snapshot → fed to `composeSeedPlan(restored)`.
   * Empty when `ok` is false (nothing is restored, so nothing is skipped).
   */
  restoredServices: ServiceId[];
  /** Flush redis after restore (rostering cache invalidation, PR #82). Always true; carried for clarity. */
  flushRedis: boolean;
}

/**
 * Plan a restore: order the dumps, evaluate the two guards, and report which
 * services come back fully.
 *
 *  - PROFILE GUARD (bypassable by `--force`): refuse a cross-profile restore.
 *  - SNAPSHOT-AHEAD GUARD (HARD, not bypassable): per pg DB with migration
 *    history, refuse if the snapshot's `schemaRev` is unknown locally — the
 *    snapshot is newer than your checkout; the user must `stack up --pull`.
 *    Skipped for `iam_pii_local` (db push, `schemaRev:null`) and `connectv3`
 *    (mongo, `schemaRev:null`) — both carry a `null` rev, so the predicate
 *    short-circuits without needing the engine.
 */
export function restorePlan(
  snapshot: SnapshotManifest,
  m: Manifest,
  localMigrations: LocalMigrations,
  opts: RestorePlanOptions = {},
): RestorePlan {
  const guardFailures: RestoreGuardFailure[] = [];

  // PROFILE GUARD.
  if (
    opts.currentProfile !== undefined &&
    opts.currentProfile !== snapshot.profile &&
    !opts.force
  ) {
    guardFailures.push({
      kind: 'profile-mismatch',
      bypassableByForce: true,
      message:
        `snapshot profile '${snapshot.profile}' does not match the current ` +
        `stack profile '${opts.currentProfile}'. Re-run with --force to restore anyway.`,
    });
  }

  // SNAPSHOT-AHEAD GUARD (per pg DB with a captured schemaRev).
  for (const entry of snapshot.databases) {
    if (entry.schemaRev === null) continue; // db-push / mongo — no history to compare
    const known = localMigrations[entry.db] ?? [];
    if (!known.includes(entry.schemaRev)) {
      guardFailures.push({
        kind: 'snapshot-ahead',
        db: entry.db,
        bypassableByForce: false,
        message:
          `snapshot for '${entry.db}' is at migration '${entry.schemaRev}', which is ` +
          `not present locally — the snapshot is ahead of your checkout. ` +
          `Run \`stack up --pull\` to update migrations, then retry.`,
      });
    }
  }

  // Order restore actions by manifest declaration order, restricted to the
  // snapshot's db set, so restore is deterministic.
  const snapEntries = new Map(snapshot.databases.map((e) => [e.db, e]));
  const actions: RestoreDbAction[] = (Object.keys(m.databases) as DbId[])
    .filter((db) => snapEntries.has(db))
    .map((db) => {
      const entry = snapEntries.get(db)!;
      return {
        db,
        engine: entry.engine,
        // Prefer the manifest's current owner role (authoritative restore-as
        // identity); fall back to whatever the snapshot recorded.
        ownerRole: m.databases[db]?.ownerRole ?? entry.ownerRole,
        container: containerFor(entry.engine, m),
        file: entry.file,
      };
    });

  const ok = guardFailures.length === 0;
  const restoredServices = ok ? fullyCoveredServices(m, new Set(snapEntries.keys())) : [];

  return { ok, actions, guardFailures, restoredServices, flushRedis: true };
}

// ---------------------------------------------------------------------------
// validate (offline / structural)
// ---------------------------------------------------------------------------

/** One structural check the runtime must evaluate (stat the file; optionally `pg_restore --list`). */
export interface FileCheck {
  db: DbId;
  engine: Engine;
  /** Path to stat — `<snapshotDir>/<file>`. */
  path: string;
  /** Declared size from the manifest, when present (cross-checked against the real size). */
  declaredSizeBytes?: number;
  /** Run `pg_restore --list` on this dump (deep mode, postgres only). */
  pgRestoreList: boolean;
}

export interface ValidatePlan {
  fixtureId: string;
  deep: boolean;
  /** The structural checks to perform (one per db in the snapshot manifest). */
  checks: FileCheck[];
}

/**
 * Build the offline structural-check plan for a snapshot. The runtime stats each
 * `path` (and, under `--deep`, runs `pg_restore --list` on the pg dumps), then
 * feeds the observations back to `evaluateValidation` for the verdict.
 *
 * NOTE: that the snapshot manifest PARSED is itself a precondition — the command
 * parses it (via `parseSnapshotManifest`) before calling this; a parse failure is
 * reported upstream as the first validation failure.
 */
export function validatePlan(
  snapshotDir: string,
  snapshot: SnapshotManifest,
  opts: { deep?: boolean } = {},
): ValidatePlan {
  const deep = opts.deep ?? false;
  const checks: FileCheck[] = snapshot.databases.map((entry) => ({
    db: entry.db,
    engine: entry.engine,
    path: joinPath(snapshotDir, entry.file),
    declaredSizeBytes: entry.sizeBytes,
    pgRestoreList: deep && entry.engine === 'postgres',
  }));
  return { fixtureId: snapshot.fixtureId, deep, checks };
}

/** What the runtime observed for one planned `FileCheck` after touching disk. */
export interface ObservedFile {
  path: string;
  exists: boolean;
  sizeBytes: number;
  /** Result of `pg_restore --list` (only when the check requested it). undefined ⇒ not run. */
  pgRestoreOk?: boolean;
}

export interface ValidationFailure {
  db: DbId;
  path: string;
  reason: 'missing' | 'empty' | 'pg-restore-list-failed';
  detail: string;
}

export interface ValidationResult {
  fixtureId: string;
  ok: boolean;
  failures: ValidationFailure[];
}

/**
 * Pure verdict: combine a `ValidatePlan` with the runtime's observed file stats
 * (keyed by path) into a pass/fail result. A db's dump must EXIST and be
 * non-empty (`sizeBytes > 0`); under `--deep`, its `pg_restore --list` must also
 * succeed. The command maps `ok:false` → exit 1 (exit-code-as-gate preserved).
 */
export function evaluateValidation(
  plan: ValidatePlan,
  observed: ReadonlyMap<string, ObservedFile>,
): ValidationResult {
  const failures: ValidationFailure[] = [];
  for (const check of plan.checks) {
    const obs = observed.get(check.path);
    if (!obs || !obs.exists) {
      failures.push({ db: check.db, path: check.path, reason: 'missing', detail: 'dump file not found' });
      continue;
    }
    if (obs.sizeBytes <= 0) {
      failures.push({ db: check.db, path: check.path, reason: 'empty', detail: 'dump file is empty (0 bytes)' });
      continue;
    }
    if (check.pgRestoreList && obs.pgRestoreOk === false) {
      failures.push({
        db: check.db,
        path: check.path,
        reason: 'pg-restore-list-failed',
        detail: '`pg_restore --list` could not read the dump (corrupt / wrong format)',
      });
    }
  }
  return { fixtureId: plan.fixtureId, ok: failures.length === 0, failures };
}

/** Minimal pure path join (avoids importing node:path into pure core). */
function joinPath(dir: string, file: string): string {
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`;
}

/**
 * M14: the BEHIND-schema check for stage checkpoints. The generic restore
 * guard above only refuses a snapshot AHEAD of the checkout (its rev unknown
 * locally); a checkpoint baked BEFORE a migration landed passes it, restores a
 * behind-schema DB, and the window's specs then run against code expecting the
 * new schema — where a full replay would have migrated first. Checkpoints are
 * replay substitutes, so they must sit AT the local migration head. Pure:
 * returns one message per behind DB (empty ⇒ ok). DBs with a null rev
 * (db-push / mongo) or with no locally-known migrations (missing sibling
 * checkout) are skipped — indeterminate, not behind.
 */
export function checkpointBehindFailures(
  snapshot: SnapshotManifest,
  localMigrations: LocalMigrations,
): string[] {
  const out: string[] = [];
  for (const entry of snapshot.databases) {
    if (entry.schemaRev == null) continue;
    const known = localMigrations[entry.db] ?? [];
    if (known.length === 0) continue;
    const head = known[known.length - 1];
    if (entry.schemaRev !== head) {
      out.push(
        `${entry.db}: checkpoint schema is at ${entry.schemaRev} but the local migration head is ${head} — ` +
          'the checkpoint pre-dates a migration; re-bake with --snapshot-stages',
      );
    }
  }
  return out;
}
