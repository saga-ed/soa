/**
 * Pure SQL builders for `ss stack hydrate`.
 *
 * Every statement hydrate runs is produced HERE, as a string, by a function with
 * no IO — so the whole destructive vocabulary (`DROP DATABASE … WITH (FORCE)`,
 * `pg_terminate_backend`, `ALTER DATABASE … RENAME`, the ownership sweep) is
 * asserted byte-for-byte in unit tests with no database anywhere. `stack
 * hydrate` introduces the first database-LEVEL destructive SQL in this package;
 * it lives behind a planner + an injectable runtime seam for exactly that
 * reason.
 *
 * DUPLICATION NOTE: `ensureRoleSql`/`createDatabaseSql` mirror the pair in
 * `runtime/provision.ts`. They are re-declared rather than imported because
 * `src/core/**` must never import `src/runtime/**` — the enforced invariant. The
 * shapes are deliberately identical; if one changes, change both.
 */

/** Quote a SQL identifier (double quotes, embedded quotes doubled). */
export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quote a SQL string literal (single quotes, embedded quotes doubled). */
export function ql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The role-ensuring `DO` block — `CREATE ROLE … LOGIN PASSWORD …` iff absent. */
export function ensureRoleSql(role: string, pw: string): string {
  return (
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=${ql(role)}) ` +
    `THEN CREATE ROLE ${qi(role)} LOGIN PASSWORD ${ql(pw)}; END IF; END $$;`
  );
}

/**
 * `CREATE DATABASE <name> OWNER <role>` — a SEPARATE statement always (CREATE
 * DATABASE cannot run inside a `DO $$…$$` block or a transaction). Creating it
 * OWNER <role> also makes PG15+'s `pg_database_owner` (the owner of schema
 * `public`) resolve to that role, which is half the writability answer for free.
 */
export function createDatabaseSql(name: string, role: string): string {
  return `CREATE DATABASE ${qi(name)} OWNER ${qi(role)}`;
}

/** `DROP DATABASE IF EXISTS <name> WITH (FORCE)` — FORCE terminates leftover backends. */
export function dropDatabaseSql(name: string): string {
  return `DROP DATABASE IF EXISTS ${qi(name)} WITH (FORCE)`;
}

/**
 * THE VIEW SWAP, resolved inside the staging database.
 *
 * A scrubbed mirror database holds `{t}_real` (the ordinary table) and a
 * scrambled VIEW at `{t}`. A dump reproduces both, so the object standing where
 * the app expects a table is a VIEW — and the app's first INSERT fails "cannot
 * insert into view". Order is load-bearing: the view OWNS the target name, so it
 * must be dropped BEFORE the rename, or the rename collides.
 *
 * Both statements go in one `-c` (one implicit transaction) so a staging
 * database can never be left with the view dropped and the table un-renamed.
 * CASCADE is required because the scramble view may itself be depended on;
 * anything it drops was scrubbed scaffolding, never app schema.
 */
export function viewSwapSql(table: string): string {
  return (
    `DROP VIEW IF EXISTS public.${qi(table)} CASCADE; ` +
    `ALTER TABLE public.${qi(`${table}_real`)} RENAME TO ${qi(table)};`
  );
}

/**
 * Re-own every restored object to the slot's single service role.
 *
 * The dump is restored with `--no-owner --no-privileges` (its `ALTER … OWNER TO
 * <prod_role>` / `GRANT … TO <service_role>` name roles that do not exist
 * locally), which lands everything owned by `postgres_admin`. That reads fine
 * and is the named SILENT FAILURE: the app's first INSERT fails days later as a
 * 500. Measured locally, each database has exactly ONE app role owning the
 * database and every object in `public`, so re-owning to that role closes it —
 * there is no multi-role grant matrix to reconstruct.
 *
 * Schema `public` is deliberately NOT re-owned: `CREATE DATABASE … OWNER <role>`
 * already makes `pg_database_owner` resolve to the role, which is the PG15+
 * idiom. Other schemas (a prod dump may carry them) ARE re-owned, or the role
 * could not create in them.
 */
export function ownershipSweepSql(role: string): string {
  const r = ql(role);
  return [
    'DO $hydrate$',
    'DECLARE r record;',
    'BEGIN',
    "  FOR r IN SELECT c.relkind AS kind, n.nspname AS ns, c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') LOOP",
    `    IF r.kind = 'S' THEN EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.ns, r.rel, ${r});`,
    `    ELSIF r.kind = 'v' THEN EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', r.ns, r.rel, ${r});`,
    `    ELSIF r.kind = 'm' THEN EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', r.ns, r.rel, ${r});`,
    `    ELSIF r.kind = 'f' THEN EXECUTE format('ALTER FOREIGN TABLE %I.%I OWNER TO %I', r.ns, r.rel, ${r});`,
    `    ELSE EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.ns, r.rel, ${r});`,
    '    END IF;',
    '  END LOOP;',
    "  FOR r IN SELECT n.nspname AS ns, t.typname AS tn FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND t.typtype IN ('e', 'd') LOOP",
    `    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.ns, r.tn, ${r});`,
    '  END LOOP;',
    "  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') LOOP",
    `    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.sig, ${r});`,
    '  END LOOP;',
    "  FOR r IN SELECT n.nspname AS ns FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'public') AND n.nspname NOT LIKE 'pg\\_%' LOOP",
    `    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.ns, ${r});`,
    '  END LOOP;',
    'END',
    '$hydrate$;',
  ].join('\n');
}

/**
 * Belt-and-braces grants for the service role (mirrors `profile-empty.sql`'s own
 * GRANT block), plus DEFAULT PRIVILEGES so objects a later migration creates as
 * `postgres_admin` stay reachable. Ownership (above) already implies these; both
 * are applied because the failure they prevent is silent.
 */
export function grantSql(role: string): string {
  const r = qi(role);
  return [
    `GRANT ALL ON SCHEMA public TO ${r};`,
    `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${r};`,
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${r};`,
    `GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ${r};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${r};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${r};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO ${r};`,
  ].join(' ');
}

/**
 * ASSERT the transfer actually landed something: `t` iff the staging database
 * has at least one relation in `public`.
 *
 * This exists because the ONE way to get hydrate badly wrong is to mis-judge
 * pg_restore's exit code. It exits non-zero on benign warnings, so a non-zero
 * exit is classified by stderr (`pgRestoreFailed`) rather than trusted — and the
 * cost of that tolerance is that a restore which did nothing at all could read
 * as green. An empty staging database is unambiguous, needs no stderr grammar,
 * and fails the database while the live one is still untouched.
 */
export function restoredSomethingSql(): string {
  return (
    'SELECT (count(*) > 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
    "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')"
  );
}

/**
 * ASSERT writability rather than assume it: how many public tables can the
 * service role NOT insert into? Must be `0`. Readable-but-not-writable is the
 * failure that otherwise surfaces days later as an app 500, so hydrate fails the
 * database here — while the live database is still untouched.
 */
export function writabilityCheckSql(role: string): string {
  return (
    'SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
    `WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT has_table_privilege(${ql(role)}, c.oid, 'INSERT')`
  );
}

/**
 * ASSERT the view swap landed: how many of the app-expected names are NOT an
 * ordinary/partitioned table? Must be `0`. This is the check that catches a
 * scrubbed database whose scramble view survived into the local slot.
 */
export function noViewsCheckSql(tables: readonly string[]): string {
  if (tables.length === 0) return 'SELECT 0';
  return (
    'SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
    `WHERE n.nspname = 'public' AND c.relname IN (${tables.map(ql).join(', ')}) AND c.relkind NOT IN ('r', 'p')`
  );
}

/** How many rows landed in a staging table (per-table progress + a non-empty sanity read). */
export function rowCountSql(table: string): string {
  return `SELECT count(*) FROM public.${qi(table)}`;
}

// ── The swap: staging → live, connected to `postgres` (never to either side) ──

/** Block NEW connections so a prisma pool cannot reconnect between terminate and rename. */
export function blockConnectionsSql(db: string): string {
  return `ALTER DATABASE ${qi(db)} WITH ALLOW_CONNECTIONS false`;
}

/** Re-allow connections (the freshly-swapped-in database, or a kept previous one). */
export function allowConnectionsSql(db: string): string {
  return `ALTER DATABASE ${qi(db)} WITH ALLOW_CONNECTIONS true`;
}

/**
 * Evict the idle prisma-pool backends. Measured on a live slot: 5 idle app
 * connections sit on content/programs/scheduling/sessions/iam_local
 * indefinitely. TRUNCATE and `pg_restore --clean` succeed against idle backends
 * (which is why `ss stack reset` works live), but `ALTER DATABASE … RENAME`
 * fails with "being accessed by other users" on ANY open session, idle included.
 */
export function terminateBackendsSql(db: string): string {
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${ql(db)} AND pid <> pg_backend_pid()`;
}

/** `ALTER DATABASE <from> RENAME TO <to>` — cannot run inside a transaction, so always its own `-c`. */
export function renameDatabaseSql(from: string, to: string): string {
  return `ALTER DATABASE ${qi(from)} RENAME TO ${qi(to)}`;
}

/** Does this database exist? (`t`/`f` — the swap's pre-check.) */
export function databaseExistsSql(db: string): string {
  return `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${ql(db)})`;
}

// ── Mirror-side discovery (read-only, run through the tunnel) ────────────────

/**
 * Enumerate the scrub's `_real` tables AND their column order, in ONE round
 * trip: `(base_table, column)` rows ordered by table then `attnum`.
 *
 * Enumerated at RUN TIME rather than hardcoded — only the `rostering` project is
 * scrubbed and its table set changes with its schema, so a hardcoded list would
 * silently skip a newly-scrubbed table and leave an un-writable view standing in
 * the app's place. The COLUMN order comes from the `_real` table (the target
 * shape), which is what makes the scrubbed-mode `COPY` column-exact instead of
 * trusting that the view happens to present columns in the same order.
 */
export function realTableQuerySql(): string {
  return (
    "SELECT left(c.relname, length(c.relname) - 5) AS base, a.attname FROM pg_class c " +
    'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
    'JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ' +
    "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE '%\\_real' " +
    'ORDER BY c.relname, a.attnum'
  );
}

/** `COPY (SELECT <cols> FROM public.<view>) TO STDOUT` — the scrambled rows, from the mirror. */
export function copyOutSql(table: string, columns: readonly string[]): string {
  const cols = columns.length === 0 ? '*' : columns.map(qi).join(', ');
  return `COPY (SELECT ${cols} FROM public.${qi(table)}) TO STDOUT`;
}

/** `COPY public.<table> (<cols>) FROM STDIN` — into the staging database's real-shaped table. */
export function copyInSql(table: string, columns: readonly string[]): string {
  const cols = columns.length === 0 ? '' : ` (${columns.map(qi).join(', ')})`;
  return `COPY public.${qi(table)}${cols} FROM STDIN`;
}
