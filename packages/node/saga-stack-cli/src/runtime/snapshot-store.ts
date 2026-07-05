/**
 * Snapshot on-disk store + container-name resolution (plan §4.3, M3).
 *
 * On-disk layout under $SAGA_MESH_SNAPSHOTS_DIR (default ~/.saga-mesh/snapshots),
 * matching mesh-fixture-cli so existing snapshot dirs stay readable:
 *
 *   <fixture-id>/
 *     manifest.json          # SnapshotManifest JSON
 *     iam_local.dump         # pg_dump -F c output, one per postgres DB
 *     iam_pii_local.dump
 *     …
 *     connectv3.archive      # mongodump --archive output (mongo DBs)
 *
 * This module performs FILESYSTEM IO (read/write/scan/delete) and resolves
 * container names from the manifest + env — but it NEVER spawns docker or a DB
 * client (that is `./snapshot.ts`'s job). It lives in `src/runtime/**` because
 * fs IO isn't pure; it may import the pure `core/manifest` for the default
 * container names and the DbId/Engine types.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getMesh, manifest as defaultManifest } from '../core/manifest/index.js';
import type { DbId, Engine, Manifest, RepoKey } from '../core/manifest/index.js';
import {
  safeParseSnapshotManifest,
  serializeSnapshotManifest,
} from '../core/snapshot/index.js';
import type { LocalMigrations, SnapshotManifest } from '../core/snapshot/index.js';
import { resolveRepoRoot } from './scripts.js';
import type { ScriptContext } from './scripts.js';

/**
 * Root dir holding all snapshot directories: `$SAGA_MESH_SNAPSHOTS_DIR ??
 * ~/.saga-mesh/snapshots`. Read at CALL time (not frozen at import) so the env
 * override is honored at runtime and tests can point it at a temp dir —
 * consistent with the `postgresContainer()`/`mongoContainer()` resolvers.
 */
export function snapshotsRoot(): string {
  return process.env.SAGA_MESH_SNAPSHOTS_DIR ?? join(homedir(), '.saga-mesh', 'snapshots');
}

// ── Container-name resolution (manifest default, env override) ──────────────
// The defaults come from the mesh manifest (soa-postgres-1 / soa-connect-mongo-1
// / soa-redis-1); env vars override for non-default compose project names.

/** Resolved postgres container: $SAGA_MESH_POSTGRES_CONTAINER ?? manifest. */
export function postgresContainer(): string {
  return process.env.SAGA_MESH_POSTGRES_CONTAINER ?? getMesh('postgres').container;
}

/** Resolved connect mongo container: $SAGA_MESH_MONGO_CONTAINER ?? manifest. */
export function mongoContainer(): string {
  return process.env.SAGA_MESH_MONGO_CONTAINER ?? getMesh('connect-mongo').container;
}

/** Resolved redis container: $SAGA_MESH_REDIS_CONTAINER ?? manifest. */
export function redisContainer(): string {
  return process.env.SAGA_MESH_REDIS_CONTAINER ?? getMesh('redis').container;
}

// ── Manifest types ──────────────────────────────────────────────────────────
//
// The on-disk `manifest.json` shape is the PURE, zod-validated `SnapshotManifest`
// from `core/snapshot/manifest.ts` (the single source of truth the planners
// consume), NOT a parallel runtime shape — read/write below go through that
// schema's parse/serialize helpers so a stale/corrupt manifest is caught at the
// boundary. `SnapshotManifest` is re-exported here for the command layer's
// convenience.

export type { SnapshotManifest } from '../core/snapshot/index.js';

/** A snapshot directory discovered on disk, with its parsed manifest (if any). */
export interface SnapshotEntry {
  fixtureId: string;
  path: string;
  sizeBytes: number;
  mtime: Date;
  manifest: SnapshotManifest | null;
}

// ── Layout helpers ────────────────────────────────────────────────────────────

/** Absolute path to a fixture's snapshot dir (whether or not it exists). */
export function snapshotDir(fixtureId: string): string {
  return join(snapshotsRoot(), fixtureId);
}

/** Dump filename for a DB by engine: `<db>.dump` (pg) / `<db>.archive` (mongo). */
export function dumpFileName(db: DbId, engine: Engine): string {
  return engine === 'mongo' ? `${db}.archive` : `${db}.dump`;
}

/** Absolute dump path inside a snapshot dir for a DB. */
export function dumpPathFor(dir: string, db: DbId, engine: Engine): string {
  return join(dir, dumpFileName(db, engine));
}

/** mkdir -p the snapshot dir. */
export function ensureSnapshotDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** File size in bytes, or 0 if the file is missing/unreadable. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ── Manifest read/write ───────────────────────────────────────────────────────

/** Write `manifest.json` into a snapshot dir (zod-re-validated, trailing newline). */
export function writeManifest(dir: string, manifest: SnapshotManifest): void {
  writeFileSync(join(dir, 'manifest.json'), serializeSnapshotManifest(manifest));
}

/**
 * Read + parse `<dir>/manifest.json`, or null when absent / unreadable / failing
 * schema validation. The validation is the boundary check for an on-disk
 * artifact a later (possibly newer) CLI reads.
 */
export function readManifest(dir: string): SnapshotManifest | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = safeParseSnapshotManifest(raw);
  return parsed.success ? parsed.data : null;
}

// ── List / delete ─────────────────────────────────────────────────────────────

/** All snapshot dirs under the snapshots root, newest-first, with parsed manifests. */
export function scanSnapshots(): SnapshotEntry[] {
  const root = snapshotsRoot();
  if (!existsSync(root)) return [];
  const entries: SnapshotEntry[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let sizeBytes = 0;
    try {
      for (const child of readdirSync(path)) {
        sizeBytes += fileSize(join(path, child));
      }
    } catch {
      // ignore unreadable children
    }
    entries.push({ fixtureId: name, path, sizeBytes, mtime: st.mtime, manifest: readManifest(path) });
  }
  return entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** True iff a snapshot dir exists for this fixture id. */
export function snapshotExists(fixtureId: string): boolean {
  return existsSync(snapshotDir(fixtureId));
}

/** Recursively remove a fixture's snapshot dir. No-op if it doesn't exist. */
export function deleteSnapshot(fixtureId: string): void {
  rmSync(snapshotDir(fixtureId), { recursive: true, force: true });
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Human byte size (B / KiB / MiB / GiB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

// ── Local prisma-migration discovery (restore snapshot-ahead guard input) ──────
//
// `restorePlan` compares each snapshot DB's recorded `schemaRev`
// (the `_prisma_migrations` head) against the migration ids PRESENT in the local
// checkout; if the snapshot's rev is unknown locally, the snapshot is ahead of
// the checkout and the (hard) guard blocks the restore. The migration ids live
// on disk as the directory names under each DB-owning package's
// `<migrate.dir>/prisma/migrations/`. This is fs IO (so it lives in runtime),
// driven entirely off the service manifest — no hardcoded DB list.

/** The RepoKey of the first service that owns `db` (where its migrate.dir is rooted). */
function ownerRepoOf(db: DbId, m: Manifest): RepoKey | undefined {
  for (const svc of Object.values(m.services)) {
    if (svc.databases.includes(db)) return svc.repo;
  }
  return undefined;
}

/**
 * The local prisma migration ids for one DB: the directory names under
 * `<owning-repo>/<migrate.dir>/prisma/migrations`. Empty for mongo / db-push /
 * unresolved checkouts (those DBs carry a `null` schemaRev, so the guard skips
 * them anyway). `ctx` carries the `--dev` / `--<repo>` path pins.
 */
export function listDbMigrations(db: DbId, m: Manifest, ctx: ScriptContext = {}): string[] {
  const def = m.databases[db];
  if (!def?.migrate || def.engine !== 'postgres') return [];
  const repo = ownerRepoOf(db, m);
  if (!repo) return [];
  // Prisma migrations live under the package's `src/prisma/migrations` (each
  // package's prisma.config.ts sets `migrations.path: './src/prisma/migrations'`),
  // which is exactly the dir up.sh's restore_source_for reads. Without the `src`
  // segment this returned [] for every DB → false "snapshot ahead" on restore.
  const migDir = join(resolveRepoRoot(repo, ctx), def.migrate.dir, 'src', 'prisma', 'migrations');
  if (!existsSync(migDir)) return [];
  try {
    return readdirSync(migDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Gather the local migration ids for every DB in a snapshot, keyed by DbId —
 * the `LocalMigrations` input `restorePlan` consumes. Only DBs with a non-null
 * `schemaRev` need it (the rest are guard-exempt), but we resolve all for
 * symmetry; missing dirs yield `[]`.
 */
export function gatherLocalMigrations(
  snapshot: SnapshotManifest,
  ctx: ScriptContext = {},
  m: Manifest = defaultManifest,
): LocalMigrations {
  const out: Record<string, readonly string[]> = {};
  for (const entry of snapshot.databases) {
    out[entry.db] = listDbMigrations(entry.db, m, ctx);
  }
  return out as LocalMigrations;
}
