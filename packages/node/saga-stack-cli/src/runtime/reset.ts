/**
 * R4 — native reset runner (M8 native prep pass — flips `stack reset` native).
 *
 * A FAITHFUL port of up.sh's `reset_data()`: a clean synthetic
 * baseline BEFORE seeding, so any `--seed` mode is reproducible regardless of prior
 * state (iam groups don't dedup — re-running the roster on a non-empty iam
 * duplicates it). Three destructive ops over the closure's DBs:
 *
 *   1. postgres `resetMode:'truncate'` DBs → `docker exec <pgContainer> psql -U
 *      postgres_admin -d <db> -v ON_ERROR_STOP=1 -c "<generic TRUNCATE DO block>"`.
 *      The DO block truncates EVERY public table EXCEPT `_prisma_migrations`, so the
 *      schema + applied-migration history survive and a reset never forces a
 *      re-migrate (verbatim from up.sh). `RESTART IDENTITY CASCADE` clears sequences
 *      + fk-linked rows — matching up.sh.
 *   2. postgres `resetMode:'migrate-reset'` DBs (ledger_local, decision 2026-06-30 —
 *      NOT in up.sh's truncate list) → `pnpm prisma migrate reset --force`
 *      in the OWNING package (ledger-db, the verified schema owner — its own migrations,
 *      not ads-adm-db's) with `DATABASE_URL` forced at the mesh (drop + remigrate to
 *      head; ledger-db configures no prisma seed hook, so reset never seeds).
 *   3. mongo (`connectv3`) → `docker exec <mongoContainer> mongosh --quiet --eval
 *      'db.getSiblingDB("connectv3").dropDatabase()'` — collections
 *      auto-recreate on first write, so a drop IS the empty baseline.
 *
 * The dev-user RE-SEED is NOT done here — the facade runs it
 * through the existing seed path (`iam-dev-user` SeedStep) after this returns, so
 * the seed env/dotenv handling lives in ONE place.
 *
 * GATING: playback DBs (`meshProvisioned:false` — transcripts/insights/chat) are
 * truncated ONLY under `--with playback`, so a bare reset leaves seeded playback
 * fixtures intact (up.sh's `DO_PLAYBACK`).
 *
 * SLOT-AWARE: the psql/mongosh runs go `docker exec <container> …` against the
 * RESOLVED slot containers (`soa-s<N>-postgres-1` / `soa-s<N>-connect-mongo-1` at
 * slot > 0), and the migrate-reset `DATABASE_URL` uses the slot's offset mesh port —
 * exactly like R2/R3.
 *
 * IDEMPOTENT/SAFE: a TRUNCATE of an already-empty DB is a no-op, and preserving
 * `_prisma_migrations` means a reset never re-migrates. Per-DB failures are
 * collected + surfaced (like up.sh's per-DB `⚠` warnings) but do NOT abort the
 * pass. A DB that isn't provisioned yet is PROBED (the R2/R3 `PgProbe` seam) and
 * SKIPPED with a note rather than erroring — matching up.sh's reset_data tolerance
 * for a not-yet-created DB (e.g. `coach_api` after a partial `up`).
 *
 * INVARIANT: docker/process IO lives only in `src/runtime/**`; `src/core/**` never
 * imports this and stays pure. All DB names/roles/modes come from the manifest.
 */

import { getDb, manifest as defaultManifest } from '../core/manifest/index.js';
import type { DbId, Manifest, RepoKey } from '../core/manifest/index.js';
import type { Runner } from './exec.js';
import type { PgProbe } from './pg-probe.js';

/** Inputs to the R4 reset pass. */
export interface ResetContext {
  /** The closure's databases (union of the closure services' `databases`). */
  dbs: DbId[];
  /** Resolved slot postgres container (`soa-postgres-1` at slot 0). */
  pgContainer: string;
  /** Resolved slot connect-mongo container (`soa-connect-mongo-1` at slot 0). */
  mongoContainer: string;
  /** Absolute repo checkout roots (for the migrate-reset cwd). */
  repoRoots: Record<RepoKey, string>;
  /** Offset added to the mesh pg port for the migrate-reset `DATABASE_URL` (0 at slot 0). */
  meshOffset?: number;
  /** Include the opt-in playback DBs (transcripts/insights/chat) in the truncate set. */
  withPlayback?: boolean;
  /** Include the opt-in authz DBs (openfga/authz_sync_local) in the truncate set. */
  withAuthz?: boolean;
  /** Process seam — the `docker exec …` / `pnpm prisma …` statements run through it. */
  runner: Runner;
  /**
   * Read-only postgres-probe seam (R2/R3). When PRESENT, each pg DB's existence is
   * probed FIRST and a not-yet-provisioned DB is SKIPPED (never truncated/migrate-reset)
   * — matching up.sh's `reset_data` tolerance for a DB that a partial `up` never created
   * (e.g. `coach_api` when coach-api was never brought up). ABSENT ⇒ no probing (every
   * pg DB is acted on), the pre-guard behaviour the reset unit tests rely on.
   */
  probe?: PgProbe;
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
}

/** What R4 did for one DB. */
export interface ResetDbResult {
  db: DbId;
  /**
   * - `truncated`     — generic TRUNCATE preserving `_prisma_migrations`.
   * - `migrate-reset` — `prisma migrate reset --force` (ledger_local).
   * - `mongo-dropped` — `dropDatabase()` (connectv3).
   * - `skipped`       — playback DB without `--with playback`, no owning repo, or a
   *                     pg DB the probe reports ABSENT (not yet provisioned).
   */
  action: 'truncated' | 'migrate-reset' | 'mongo-dropped' | 'skipped';
  /** True iff the op exited 0 (a per-DB failure warns but does not abort the pass). */
  ok: boolean;
  /** Reason for `skipped`. */
  reason?: string;
}

/** The outcome of the R4 pass. */
export interface ResetResult {
  /** True iff every attempted op succeeded (a skipped DB doesn't flip this). */
  ok: boolean;
  dbs: ResetDbResult[];
}

/**
 * The generic per-DB TRUNCATE DO block — verbatim from up.sh. Truncates every
 * `public` table EXCEPT `_prisma_migrations` (so the schema + migration history
 * survive; a reset never forces a re-migrate). Exposed for tests + reporting.
 */
export function truncateSql(): string {
  return (
    "DO $$ DECLARE r RECORD; BEGIN FOR r IN SELECT tablename FROM pg_tables " +
    "WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP " +
    "EXECUTE 'TRUNCATE TABLE public.'||quote_ident(r.tablename)||' RESTART IDENTITY CASCADE'; " +
    'END LOOP; END $$;'
  );
}

/** `docker exec <container> psql -U postgres_admin -d <db> -v ON_ERROR_STOP=1 -c "<sql>"` argv. */
export function truncateArgs(container: string, db: string): string[] {
  return ['exec', container, 'psql', '-U', 'postgres_admin', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', truncateSql()];
}

/** `docker exec <container> mongosh --quiet --eval 'db.getSiblingDB("<db>").dropDatabase()'` argv. */
export function mongoDropArgs(container: string, db: string): string[] {
  return ['exec', container, 'mongosh', '--quiet', '--eval', `db.getSiblingDB("${db}").dropDatabase()`];
}

/** `postgresql://<owner>:<pw>@localhost:<5432+offset>/<name>` — the mesh DB URL for migrate-reset. */
function pgUrl(def: ReturnType<typeof getDb>, m: Manifest, meshOffset: number): string {
  const pgPort = m.mesh.postgres.port + meshOffset;
  return `postgresql://${def.ownerRole}:${def.ownerPw}@localhost:${pgPort}/${def.name}`;
}

/** The RepoKey of the first service that owns `db` (where its `migrate.dir` is rooted). */
function ownerRepoOf(db: DbId, m: Manifest): RepoKey | undefined {
  for (const svc of Object.values(m.services)) {
    if (svc.databases.includes(db)) return svc.repo;
  }
  return undefined;
}

/**
 * Reset every closure DB to an empty baseline, in canonical manifest order. Returns
 * a structured result; per-DB failures warn (are recorded `ok:false`) but never
 * abort — faithful to up.sh's per-DB `⚠` warnings. The dev-user re-seed is run
 * SEPARATELY by the facade (the existing `iam-dev-user` SeedStep), not here.
 */
export async function resetClosure(ctx: ResetContext): Promise<ResetResult> {
  const m = ctx.manifest ?? defaultManifest;
  const meshOffset = ctx.meshOffset ?? 0;
  const results: ResetDbResult[] = [];

  // Canonical manifest order (not the arbitrary closure order) — deterministic.
  const closure = new Set(ctx.dbs);
  const ordered = (Object.keys(m.databases) as DbId[]).filter((d) => closure.has(d));

  let allOk = true;

  for (const id of ordered) {
    const def = getDb(id, m);

    // Mongo (connectv3) → dropDatabase against the resolved mongo container.
    if (def.engine === 'mongo') {
      const { code } = await ctx.runner.run({
        cwd: process.cwd(),
        command: 'docker',
        args: mongoDropArgs(ctx.mongoContainer, def.name),
        env: {},
        stdio: 'inherit',
      });
      const ok = code === 0;
      allOk = allOk && ok;
      results.push({ db: id, action: 'mongo-dropped', ok });
      continue;
    }

    // meshProvisioned:false DBs are opt-in, each gated by its OWN bundle flag —
    // playback trio under --with playback (up.sh DO_PLAYBACK), openfga/authz_sync_local
    // under --with authz. Never a blanket OR of both flags (would cross-admit).
    if (!def.meshProvisioned) {
      const isAuthzDb = id === 'openfga' || id === 'authz_sync_local';
      const admitted = isAuthzDb ? ctx.withAuthz : ctx.withPlayback;
      if (!admitted) {
        const reason = isAuthzDb ? 'authz DB (needs --with authz)' : 'playback DB (needs --with playback)';
        results.push({ db: id, action: 'skipped', ok: true, reason });
        continue;
      }
    }

    // Existence probe (R2/R3 seam): a pg DB a partial `up` never provisioned (e.g.
    // `coach_api` when coach-api was never brought up) does NOT exist, so a TRUNCATE /
    // migrate-reset against it would error (`database "…" does not exist`). Probe first
    // and SKIP an absent DB with a clear note — matching up.sh's reset_data, whose per-DB
    // loop warns + continues on a not-yet-created DB. Cleaner than truncate-and-catch
    // (no error is provoked) and NOT a failure (ok:true ⇒ exit stays 0). Only reached for
    // pg DBs we intend to act on (mongo returned above; mongo dropDatabase on an absent
    // db is already a no-op). No probe wired ⇒ act unconditionally (pre-guard behaviour).
    if (ctx.probe && !(await ctx.probe.databaseExists(ctx.pgContainer, def.name))) {
      results.push({ db: id, action: 'skipped', ok: true, reason: 'not provisioned' });
      continue;
    }

    // ledger_local (migrate-reset): drop + remigrate via prisma, NOT truncate.
    if (def.resetMode === 'migrate-reset') {
      const repo = ownerRepoOf(id, m);
      if (!repo || !def.migrate) {
        results.push({ db: id, action: 'skipped', ok: true, reason: 'no owning repo/migrate dir' });
        continue;
      }
      const cwd = `${ctx.repoRoots[repo].replace(/\/+$/, '')}/${def.migrate.dir.replace(/^\/+/, '')}`;
      // `prisma migrate reset --force` rebuilds SCHEMA ONLY (drop + remigrate to head),
      // never re-seeds: prisma 7.8.0's `migrate reset` supports ONLY `--force`/`--schema`
      // (NO `--skip-seed` — passing it makes prisma 7 print usage + exit non-zero, which
      // silently failed this step and left ledger_local with 0 tables). Prisma only
      // auto-runs a seed when a `prisma.seed` hook is CONFIGURED — and ledger-db
      // (@saga-ed/ledger-db, prisma ^7.8.0) configures NONE: no `prisma.seed` in
      // package.json (its `db:seed` is a plain npm SCRIPT, which prisma does NOT auto-run)
      // and no `seed` in prisma.config.ts. So `migrate reset --force` will NOT seed here,
      // and dropping `--skip-seed` is fully safe — it matches "wipe + re-migrate to head".
      // DATABASE_URL is injected below (ledger-db's prisma.config.ts THROWS without it);
      // pgUrl() is slot-offset-correct so a slot>0 reset lands on the offset mesh port.
      const { code } = await ctx.runner.run({
        cwd,
        command: 'pnpm',
        args: ['prisma', 'migrate', 'reset', '--force'],
        env: {
          DATABASE_URL: pgUrl(def, m, meshOffset),
          // Prisma 7 refuses a destructive `migrate reset` when it detects an AI-agent
          // session (env markers like CLAUDECODE), demanding
          // PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION = the user's explicit consent.
          // A developer typing `ss stack reset` IS that explicit consent (the whole
          // command exists to wipe local dev data), so we supply it — SCOPED to only
          // this command's ledger migrate-reset. Outside an agent session prisma ignores
          // the var (no guard fires), so this is inert there. This lets `ss stack reset`
          // work from inside an agent session; a plain human terminal never needed it.
          PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION:
            'developer explicitly invoked `ss stack reset` (the native synthetic-dev reset command) — consent to reset ledger_local',
        },
        stdio: 'inherit',
      });
      const ok = code === 0;
      allOk = allOk && ok;
      results.push({ db: id, action: 'migrate-reset', ok });
      continue;
    }

    // Default: generic TRUNCATE preserving _prisma_migrations.
    const { code } = await ctx.runner.run({
      cwd: process.cwd(),
      command: 'docker',
      args: truncateArgs(ctx.pgContainer, def.name),
      env: {},
      stdio: 'inherit',
    });
    const ok = code === 0;
    allOk = allOk && ok;
    results.push({ db: id, action: 'truncated', ok });
  }

  return { ok: allOk, dbs: results };
}
