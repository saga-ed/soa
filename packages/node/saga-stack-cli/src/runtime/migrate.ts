/**
 * R3 — native migrate runner (M8 native prep pass — THE headline).
 *
 * A FAITHFUL port of up.sh's `migrate_db()` (up.sh:738-755, the three-way branch)
 * + the migrate chain (up.sh:1040-1073, canonical order). `profile-empty.sql`
 * leaves every app DB table-EMPTY, so without a migrate the fatal seed steps
 * (iam/sessions/programs/scheduling) run against an unmigrated schema and abort.
 * The manifest already carries complete `MigrateSpec` data, but NOTHING executed
 * it — this runner is that missing executor.
 *
 * For each closure DB, in CANONICAL MANIFEST ORDER, we run its `MigrateSpec`:
 *
 *   FIXED steps (up.sh runs these via `db_step`, NOT the branch):
 *     - `cmd: 'prisma migrate deploy'` → `pnpm prisma migrate deploy` (iam-db, ads-adm-db)
 *     - `cmd: 'prisma db push'`        → `pnpm prisma db push`        (iam-pii-db)
 *
 *   THREE-WAY BRANCH (up.sh's `migrate_db`, for the `cmd: 'db:deploy'` targets —
 *   programs/scheduling/sessions/content/coach/sis), probing `_prisma_migrations`:
 *     - migration-managed (has `_prisma_migrations`)   → `pnpm db:deploy`   (apply pending)
 *     - empty (no public tables)                       → `pnpm db:deploy`   (replay full history)
 *     - unmanaged (tables, no `_prisma_migrations`)    → `pnpm prisma migrate reset --force`
 *
 * FIDELITY:
 *   - The `cmd` field discriminates a `migrate_db` (branch) target from a fixed
 *     `db_step` target — exactly matching up.sh's chain, where iam-db/ads-adm-db
 *     use `pnpm prisma migrate deploy` and iam-pii-db uses `pnpm prisma db push`,
 *     while the program-hub apps + coach + sis go through the branch.
 *   - `iam-pii db push` is preserved as its own step, in its manifest order slot.
 *   - `databaseUrlOverride:true` (programs/scheduling/sessions/content/coach_api)
 *     forces `DATABASE_URL` at the mesh postgres (port = 5432 + meshOffset), since
 *     the program-hub apps + coach-db default to their own :5433 — up.sh passes
 *     `$PROGRAMS_DB_URL`/…/`$COACH_DB_URL`.
 *   - The migrate command runs in `<repoRoot>/<migrate.dir>` (the package/app dir,
 *     e.g. `packages/node/iam-db`); prisma resolves its `src/prisma/migrations`
 *     from the package's prisma.config.ts, exactly as up.sh's `( cd "$dir" && … )`.
 *
 * LEDGER (migrate-reset target): ledger_local is NOT a prep-migrate target —
 * up.sh's prep chain (up.sh:1041-1073) has no ledger step. profile-empty.sql
 * provisions it empty and its schema is (re)built by the R4 reset's migrate-reset
 * (drop + remigrate) against its own owning package, `packages/node/ledger-db`
 * (the VERIFIED schema owner — NOT ads-adm-db). R3 skips any `resetMode:'migrate-reset'`
 * DB for that reason.
 *
 * PER-PACKAGE DEDUP: a general guard for two DBs sharing one owning `(repo, dir)`
 * package — the first in canonical order migrates, the later same-package DB is
 * skipped (up.sh migrates a package once). No current DB pair trips it (ledger_local
 * and ads_adm_local now own DISTINCT packages), but it stays as a safety net.
 *
 * SLOT-AWARE + IDEMPOTENT: probes/creates target the resolved slot pg container;
 * `migrate deploy`/`db:deploy` are idempotent (apply-pending — a re-up on a
 * migrated DB is a fast no-op), so wiring this into every native `up` is safe for
 * the soaked `--only` path.
 *
 * INVARIANT: docker/process IO lives only in `src/runtime/**`; `src/core/**`
 * never imports this and stays pure. Repo/dir/cmd/owner all come from the manifest.
 */

import { getDb, manifest as defaultManifest } from '../core/manifest/index.js';
import type { DbId, Manifest, MigrateSpec, RepoKey } from '../core/manifest/index.js';
import type { Runner } from './exec.js';
import type { PgProbe } from './pg-probe.js';

/** Which of the three up.sh branches a `db:deploy` target took (null for the fixed steps). */
export type MigrateBranch = 'managed' | 'empty' | 'unmanaged' | 'fixed';

/** Inputs to the R3 migrate pass. */
export interface MigrateContext {
  /** The closure's databases (union of the closure services' `databases`). */
  dbs: DbId[];
  /** Resolved slot postgres container (`soa-postgres-1` at slot 0) — for the probe. */
  pgContainer: string;
  /** Offset added to the mesh pg port for the `databaseUrlOverride` URL (0 at slot 0). */
  meshOffset?: number;
  /** Absolute repo checkout roots keyed by manifest `RepoKey` (for the migrate cwd). */
  repoRoots: Record<RepoKey, string>;
  /** Process seam — the `pnpm …` migrate commands run through it. */
  runner: Runner;
  /** Read-only probe seam — the `_prisma_migrations` / table-count branch selection. */
  probe: PgProbe;
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
}

/** What R3 did for one DB. */
export interface MigrateDbResult {
  db: DbId;
  /** The branch taken, or null when the DB was skipped. */
  branch: MigrateBranch | null;
  ok: boolean;
  /** The exact command run (for reporting), e.g. `pnpm db:deploy`. */
  command?: string;
  /** Reason the DB was skipped (no-schema / non-postgres / not-provisioned / dup-package). */
  skipped?: string;
}

/** The outcome of the R3 pass. */
export interface MigrateResult {
  ok: boolean;
  dbs: MigrateDbResult[];
  /** The DB whose migrate failed (set only when `ok` is false). */
  failed?: DbId;
}

/** The RepoKey of the first service that owns `db` (where its `migrate.dir` is rooted). */
function ownerRepoOf(db: DbId, m: Manifest): RepoKey | undefined {
  for (const svc of Object.values(m.services)) {
    if (svc.databases.includes(db)) return svc.repo;
  }
  return undefined;
}

/** `postgresql://<owner>:<pw>@localhost:<5432+offset>/<name>` — the mesh DB URL up.sh passes. */
function pgUrl(def: ReturnType<typeof getDb>, m: Manifest, meshOffset: number): string {
  const pgPort = m.mesh.postgres.port + meshOffset;
  return `postgresql://${def.ownerRole}:${def.ownerPw}@localhost:${pgPort}/${def.name}`;
}

/** Split a `MigrateSpec.cmd` string into a pnpm argv (fixed steps only). */
function fixedArgv(cmd: MigrateSpec['cmd']): string[] {
  // 'prisma migrate deploy' | 'prisma db push' → ['prisma','migrate','deploy'] etc.
  return cmd.split(/\s+/);
}

/**
 * A pure preview of one DB's migrate plan (cwd + argv + env), given its probed
 * branch. Exposed for tests + reporting; `migrateClosure` executes it.
 */
export interface MigrateDbPlan {
  db: DbId;
  branch: MigrateBranch;
  cwd: string;
  /** argv AFTER `pnpm` (e.g. `['db:deploy']`, `['prisma','migrate','reset','--force']`). */
  argv: string[];
  /** Extra env (only `DATABASE_URL` when `databaseUrlOverride`). */
  env: Record<string, string>;
}

/**
 * Resolve one DB's migrate plan. `probedBranch` is only consulted for `db:deploy`
 * targets (the up.sh `migrate_db` three-way); fixed `prisma migrate deploy` /
 * `prisma db push` targets ignore it and run their authored command verbatim.
 */
export function planMigrate(
  db: DbId,
  spec: MigrateSpec,
  repoRoot: string,
  m: Manifest,
  meshOffset: number,
  probedBranch: Exclude<MigrateBranch, 'fixed'>,
): MigrateDbPlan {
  const def = getDb(db, m);
  const cwd = `${repoRoot.replace(/\/+$/, '')}/${spec.dir.replace(/^\/+/, '')}`;
  const env: Record<string, string> = spec.databaseUrlOverride
    ? { DATABASE_URL: pgUrl(def, m, meshOffset) }
    : {};

  // BLOCKER-A: packages whose prisma.config.ts REQUIRES a specific env var (iam-db
  // DATABASE_URL, iam-pii-db PII_DATABASE_URL, sis-db SIS_DATABASE_URL) would THROW
  // on a fresh checkout with no `$ROSTERING/.env.local`. up.sh writes that file
  // before prep; native injects the var straight into the child env instead — at
  // the slot-offset-correct mesh port, so a slot>0 sis lands on its offset pg, not
  // :5432. (`databaseUrlOverride` DBs already carry their own URL and set no
  // `migrateEnvVar`, so the two paths never collide.)
  if (spec.migrateEnvVar) {
    env[spec.migrateEnvVar] = pgUrl(def, m, meshOffset);
  }

  if (spec.cmd !== 'db:deploy') {
    // FIXED db_step target (iam-db / iam-pii-db / ads-adm-db) — no branch.
    return { db, branch: 'fixed', cwd, argv: fixedArgv(spec.cmd), env };
  }

  // db:deploy target — the up.sh migrate_db three-way branch.
  const argv =
    probedBranch === 'unmanaged'
      ? ['prisma', 'migrate', 'reset', '--force'] // db:push'd, no history → drop + replay
      : ['db:deploy']; // managed (apply pending) OR empty (replay full history)
  return { db, branch: probedBranch, cwd, argv, env };
}

/**
 * Migrate every closure DB, in canonical manifest order, per its `MigrateSpec`.
 * Skips mongo (no schema), playback (`meshProvisioned:false` — provisioned by R5),
 * and same-package duplicates (ledger_local, see the header). Returns a structured
 * result; a failed migrate stops the pass with `ok:false`.
 */
export async function migrateClosure(ctx: MigrateContext): Promise<MigrateResult> {
  const m = ctx.manifest ?? defaultManifest;
  const meshOffset = ctx.meshOffset ?? 0;
  const results: MigrateDbResult[] = [];

  // Iterate in CANONICAL MANIFEST ORDER, not the (arbitrary) closure order —
  // faithful to up.sh's fixed chain (iam → iam-pii → programs → … → ads-adm).
  const closure = new Set(ctx.dbs);
  const ordered = (Object.keys(m.databases) as DbId[]).filter((d) => closure.has(d));

  // Per-package dedup: a `(repo, dir)` already migrated is skipped (ledger_local).
  const migratedPackages = new Set<string>();

  for (const id of ordered) {
    const def = getDb(id, m);

    if (!def.migrate || def.engine !== 'postgres') {
      results.push({ db: id, branch: null, ok: true, skipped: 'no schema (mongo auto-creates)' });
      continue;
    }
    if (!def.meshProvisioned) {
      results.push({ db: id, branch: null, ok: true, skipped: 'not mesh-provisioned (playback — R5)' });
      continue;
    }
    if (def.resetMode === 'migrate-reset') {
      // ledger_local (resetMode:'migrate-reset') is NOT a prep-migrate target —
      // up.sh's prep chain (up.sh:1041-1073) has NO ledger step. profile-empty.sql
      // provisions it empty and its schema is (re)built by the R4 reset's
      // migrate-reset (drop + remigrate) against its OWN owning package (ledger-db).
      // Skipping it here keeps R3 faithful to up.sh now that ledger-db is a DISTINCT
      // package (so the per-package dedup below no longer coincidentally catches it).
      results.push({ db: id, branch: null, ok: true, skipped: 'migrate-reset target (schema via R4 reset, not prep)' });
      continue;
    }

    const repo = ownerRepoOf(id, m);
    if (!repo) {
      results.push({ db: id, branch: null, ok: true, skipped: 'no owning service/repo' });
      continue;
    }

    const pkgKey = `${repo}::${def.migrate.dir}`;
    if (migratedPackages.has(pkgKey)) {
      // ledger_local shares ads-adm-db with ads_adm_local — up.sh migrates the
      // package once; ledger_local is lazily populated, not a prep-migrate target.
      results.push({ db: id, branch: null, ok: true, skipped: `duplicate package ${def.migrate.dir}` });
      continue;
    }
    migratedPackages.add(pkgKey);

    // Branch selection — only the db:deploy targets consult the probe; fixed steps
    // pass a placeholder that planMigrate ignores.
    let branch: Exclude<MigrateBranch, 'fixed'> = 'empty';
    if (def.migrate.cmd === 'db:deploy') {
      if (await ctx.probe.hasMigrationsTable(ctx.pgContainer, def.name)) {
        branch = 'managed';
      } else {
        const count = await ctx.probe.publicTableCount(ctx.pgContainer, def.name);
        branch = count === 0 ? 'empty' : 'unmanaged';
      }
    }

    const plan = planMigrate(id, def.migrate, ctx.repoRoots[repo], m, meshOffset, branch);
    const command = `pnpm ${plan.argv.join(' ')}`;
    const { code } = await ctx.runner.run({
      cwd: plan.cwd,
      command: 'pnpm',
      args: plan.argv,
      env: plan.env,
      stdio: 'inherit',
    });
    if (code !== 0) {
      results.push({ db: id, branch: plan.branch, ok: false, command });
      return { ok: false, dbs: results, failed: id };
    }
    results.push({ db: id, branch: plan.branch, ok: true, command });
  }

  return { ok: true, dbs: results };
}
