/**
 * The `ss stack hydrate` PLANNER — pure.
 *
 * Given a source description (mode, selected databases, the tunnel's local end,
 * the slot's postgres container/port, and the `_real` tables discovered on the
 * mirror), this produces the COMPLETE ordered step list for the whole run: every
 * `pg_dump`/`pg_restore`/`psql` argv, every SQL statement, the rename plan, the
 * ownership/grant sweep, the verification checks, and the swap. The executor
 * (`runtime/hydrate.ts` + `commands/stack/hydrate.ts`) does no thinking: it runs
 * `step.dockerArgv`, checks `step.expect`, and reports. That split is what lets
 * the risky logic be asserted byte-for-byte with no database anywhere.
 *
 * TWO STRUCTURAL FACTS SHAPE EVERY PLAN
 *
 * 1. THE CLIENT RUNS IN AN EPHEMERAL CONTAINER ON HOST NETWORKING.
 *    `docker exec soa-postgres-1 pg_dump -h 127.0.0.1 …` cannot work: the mesh
 *    container is on a compose bridge network, so its 127.0.0.1 is ITSELF, not
 *    the host holding the SSM tunnel. `docker run --rm --network host postgres:18`
 *    sees BOTH the tunnel port and the slot's published postgres port, so a whole
 *    transfer is one piped `bash -o pipefail -c 'pg_dump … | pg_restore …'` with
 *    no dump file on disk. (Linux `--network host` semantics; Docker Desktop on
 *    macOS differs — stated as an assumption, not silently relied on.)
 *
 * 2. NOTHING TOUCHES THE LIVE DATABASE UNTIL IT IS PROVEN GOOD.
 *    Every database is restored into a STAGING database, has its surgery done
 *    there (view swap, re-own, grant), is VERIFIED there, and only then is
 *    swapped in by rename. A failure at any step leaves the live database
 *    exactly as it was — rollback is free, and `--keep-previous` keeps the
 *    displaced database around as a one-command undo.
 *
 * CREDENTIALS: the mirror's master password is NEVER an argv element. Transfer
 * steps carry a bare `-e PGPASSWORD` (no `=value`), so docker inherits it from
 * the spawn's `env` — `/proc/<pid>/environ` is same-user-only, argv is world
 * readable in `ps`. `--no-password` is set on every mirror-side client so a
 * missing credential fails fast instead of hanging on a prompt.
 */

import {
  allowConnectionsSql,
  blockConnectionsSql,
  copyInSql,
  copyOutSql,
  createDatabaseSql,
  dropDatabaseSql,
  ensureRoleSql,
  grantSql,
  noViewsCheckSql,
  ownershipSweepSql,
  renameDatabaseSql,
  restoredSomethingSql,
  terminateBackendsSql,
  viewSwapSql,
  writabilityCheckSql,
} from './sql.js';
import { localTarget } from './databases.js';
import type { MirrorDbDef, SourceMode } from './databases.js';
import type { DbId, Manifest } from '../manifest/index.js';

/** Default local end of hydrate's SSM tunnel — deliberately NOT `env connect`'s 15432. */
export const DEFAULT_LOCAL_PORT = 15532;

/**
 * The ephemeral client image. Pinned to `postgres:18` because the mirror is PG
 * 18.3 and pg_dump refuses to run OLDER than its server (a hard error, not a
 * warning) — and to the DEBIAN variant, not `-alpine`, because the plan runs its
 * pipelines under `bash -o pipefail` so a failing `pg_dump` cannot be masked by
 * a succeeding `pg_restore` (alpine's `sh` is not bash and has no `pipefail`).
 */
export const DEFAULT_CLIENT_IMAGE = 'postgres:18';

/** The mirror master user (the RDS master secret's `username`). */
export const MIRROR_ADMIN_USER = 'saga_admin';

/**
 * Field separator for the mirror-side discovery read — the ASCII unit separator,
 * so a value containing a comma/tab/pipe can never be mis-split (the same stance
 * `runtime/env-psql.ts` takes).
 */
export const FIELD_SEP = '\u001f';

/** The local mesh superuser every `docker exec … psql` connects as. */
export const LOCAL_ADMIN_USER = 'postgres_admin';

/** Per-scrubbed-database discovery: the `_real` tables and their column order. */
export interface RealTableInfo {
  /** App-facing table name (the VIEW's name; the real table is `<table>_real`). */
  table: string;
  /** Column names in the `_real` table's `attnum` order. Empty ⇒ `SELECT *`. */
  columns: string[];
}

export interface HydratePlanInput {
  slot: number;
  mode: SourceMode;
  /** Selected mirror→local mappings, in report order. */
  selection: readonly MirrorDbDef[];
  /** Slot postgres container (`soa-postgres-1` / `soa-s<N>-postgres-1`). */
  pgContainer: string;
  /** Slot postgres host port (`5432 + slot * 1000`). */
  localPort: number;
  /** Local end of the SSM tunnel to the mirror. */
  mirrorLocalPort: number;
  /** Mirror master username, resolved from the master secret at run time. */
  mirrorUser?: string;
  /** Which local databases already exist (drives the swap's rename-away step). */
  localExists: Readonly<Record<string, boolean>>;
  /** `_real` tables per MIRROR database name — discovered live, or the confirmed set in a preview. */
  realTables?: Readonly<Record<string, readonly RealTableInfo[]>>;
  /** Timestamp token for the displaced database's name (`<db>__pre_hydrate_<stamp>`). */
  stamp: string;
  /** Keep the displaced database instead of dropping it (one-command rollback). */
  keepPrevious?: boolean;
  clientImage?: string;
  manifest?: Manifest;
}

interface StepBase {
  /** Stable id (`iam_local:transfer`) — what tests and `--output-json` key on. */
  id: string;
  /** One human line, printed as the step runs. */
  label: string;
  /** The FULL `docker` argv. The executor spawns exactly this and nothing else. */
  dockerArgv: string[];
  /** True ⇒ the executor injects the mirror password as PGPASSWORD in the child env only. */
  needsSecret?: boolean;
}

export interface SqlStep extends StepBase {
  kind: 'sql';
  /** Local database the statement runs against (`postgres` for database-level DDL). */
  database: string;
  sql: string;
  /** When set, the step's trimmed stdout MUST equal this or the database fails. */
  expect?: string;
  /** The failure message when `expect` does not match (`%s` ⇒ the actual value). */
  expectMessage?: string;
  /**
   * Retry count for the ONE genuinely racy step: `ALTER DATABASE … RENAME`
   * immediately after `pg_terminate_backend`, where a backend may not be fully
   * reaped yet. ALLOW_CONNECTIONS is already false, so no NEW session can appear
   * — a retry always converges.
   */
  retries?: number;
}

export interface TransferStep extends StepBase {
  kind: 'transfer';
  needsSecret: true;
  /** The `bash -o pipefail -c` pipeline (exported so tests read it directly). */
  shell: string;
  /** The mirror-side producer argv (`pg_dump` or `psql … COPY … TO STDOUT`). */
  sourceArgv: string[];
  /** The local-side consumer argv (`pg_restore` or `psql … COPY … FROM STDIN`). */
  sinkArgv: string[];
  /**
   * How to judge a non-zero exit. `pg_restore` exits non-zero on BENIGN warnings
   * too, and a `--no-owner --no-privileges` prod dump emits a pile of them —
   * so those steps are classified with `pgRestoreFailed`, not by exit code.
   * `psql` steps run `ON_ERROR_STOP=1` and mean what their exit code says.
   */
  classify: 'pg_restore' | 'psql';
}

export type HydrateStep = SqlStep | TransferStep;

export interface HydrateDbPlan {
  local: DbId;
  localName: string;
  mirrorName: string;
  ownerRole: string;
  scrubbed: boolean;
  mode: SourceMode;
  stagingName: string;
  /** Where the displaced live database is parked (absent when there was none). */
  retiredName: string;
  localExisted: boolean;
  /** `{t}_real` → `{t}` renames performed in staging (both source modes). */
  renamedTables: string[];
  /** Tables whose SCRAMBLED rows are copied from the mirror (scrubbed mode only). */
  copiedTables: string[];
  steps: HydrateStep[];
}

export interface HydratePlan {
  slot: number;
  mode: SourceMode;
  pgContainer: string;
  localPort: number;
  mirrorLocalPort: number;
  keepPrevious: boolean;
  clientImage: string;
  dbs: HydrateDbPlan[];
}

/** POSIX single-quote shell escaping (exported: the pipeline strings are asserted byte-for-byte). */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `docker exec <container> psql -U postgres_admin -v ON_ERROR_STOP=1 -d <db> -tAc <sql>` argv. */
export function localPsqlArgv(container: string, database: string, sql: string): string[] {
  return [
    'exec',
    container,
    'psql',
    '-U',
    LOCAL_ADMIN_USER,
    '-v',
    'ON_ERROR_STOP=1',
    '-X',
    '-q',
    '-d',
    database,
    '-tAc',
    sql,
  ];
}

/**
 * Wrap a producer|consumer pipeline in the ephemeral host-networked client
 * container. `-e PGPASSWORD` is BARE on purpose: docker then inherits the value
 * from the spawning process's environment instead of putting the secret in argv.
 */
export function clientRunArgv(image: string, pipeline: string): string[] {
  return ['run', '--rm', '--network', 'host', '-e', 'PGPASSWORD', image, 'bash', '-o', 'pipefail', '-c', pipeline];
}

/** Mirror-side connection args (the tunnel's LOCAL end — never the RDS endpoint). */
function mirrorConnArgs(port: number, user: string, database: string): string[] {
  return ['--host', '127.0.0.1', '--port', String(port), '--username', user, '--dbname', database, '--no-password'];
}

/** Local-side connection args (the slot's published postgres port; `trust` auth locally). */
function localConnArgs(port: number, database: string): string[] {
  return ['--host', '127.0.0.1', '--port', String(port), '--username', LOCAL_ADMIN_USER, '--dbname', database, '--no-password'];
}

/**
 * `pg_dump` argv for one mirror database (custom format, streamed to stdout).
 *
 * `--no-owner`/`--no-privileges` are deliberately NOT here: for archive formats
 * pg_dump documents `--no-owner` as meaningful only for plain text, so they go
 * on `pg_restore` where they are unambiguously effective (see `pgRestoreArgv`).
 *
 * `excludeData` carries the scrub's `_real` tables in SCRUBBED mode: their
 * STRUCTURE crosses (PK, FKs, indexes, defaults, sequence ownership — which is
 * what makes the materialised table a real writable table instead of a
 * constraint-less CTAS), but not one row of unscrubbed data.
 */
export function pgDumpArgv(opts: {
  mirrorPort: number;
  user: string;
  database: string;
  excludeData?: readonly string[];
}): string[] {
  const argv = ['pg_dump', ...mirrorConnArgs(opts.mirrorPort, opts.user, opts.database), '--format', 'custom'];
  for (const table of opts.excludeData ?? []) argv.push(`--exclude-table-data=public.${table}_real`);
  return argv;
}

/**
 * `pg_restore` argv into the staging database, as the LOCAL SUPERUSER.
 *
 * Restoring as `postgres_admin` (not as the owner, which is what
 * `stack snapshot restore` does) is deliberate: those snapshots came from the
 * same mesh, whereas a prod dump can carry `CREATE EXTENSION`, event triggers or
 * publications a non-superuser cannot create, and the restore would fail
 * mid-way. Ownership is then swept to the service role explicitly.
 */
export function pgRestoreArgv(opts: { localPort: number; staging: string }): string[] {
  return [
    'pg_restore',
    ...localConnArgs(opts.localPort, opts.staging),
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
  ];
}

/** `psql … -c <sql>` argv, unit-separator-delimited (mirror-side read/COPY-out). */
export function mirrorPsqlArgv(opts: { mirrorPort: number; user: string; database: string; sql: string }): string[] {
  return [
    'psql',
    ...mirrorConnArgs(opts.mirrorPort, opts.user, opts.database),
    '-X',
    '-q',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    opts.sql,
  ];
}

/** `psql … -c <sql>` argv against a local database over TCP (the COPY-in sink). */
export function localTcpPsqlArgv(opts: { localPort: number; database: string; sql: string }): string[] {
  return ['psql', ...localConnArgs(opts.localPort, opts.database), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', opts.sql];
}

/**
 * The one read hydrate makes against the mirror before planning: the `_real`
 * table + column enumeration. Built here so the command never hand-rolls argv.
 */
export function mirrorDiscoveryArgv(opts: {
  image?: string;
  mirrorPort: number;
  user: string;
  database: string;
  sql: string;
  fieldSep?: string;
}): string[] {
  const argv = [
    'psql',
    ...mirrorConnArgs(opts.mirrorPort, opts.user, opts.database),
    '-X',
    '-q',
    '-A',
    '-t',
    '-F',
    opts.fieldSep ?? FIELD_SEP,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    opts.sql,
  ];
  return [
    'run',
    '--rm',
    '--network',
    'host',
    '-e',
    'PGPASSWORD',
    opts.image ?? DEFAULT_CLIENT_IMAGE,
    ...argv,
  ];
}

/** Staging database name for a local database (deterministic — dropped-if-exists first). */
export function stagingNameFor(localName: string): string {
  return `${localName}__hydrate`;
}

/** Where the displaced live database is parked. */
export function retiredNameFor(localName: string, stamp: string): string {
  return `${localName}__pre_hydrate_${stamp}`;
}

/** Plan one database's full hydrate. */
function planDb(def: MirrorDbDef, input: HydratePlanInput): HydrateDbPlan {
  const image = input.clientImage ?? DEFAULT_CLIENT_IMAGE;
  const user = input.mirrorUser ?? MIRROR_ADMIN_USER;
  const { name: localName, ownerRole, ownerPw } = localTarget(def, input.manifest);
  const staging = stagingNameFor(localName);
  const retired = retiredNameFor(localName, input.stamp);
  const localExisted = input.localExists[localName] === true;
  const container = input.pgContainer;

  // The scrub only touches the two rostering databases; everywhere else BOTH
  // source modes land identical raw prod data. Say so via the plan shape rather
  // than letting a reader infer that `--source scrubbed` sanitises the run.
  const real = def.scrubbed ? (input.realTables?.[def.mirror] ?? []) : [];
  const materialise = def.scrubbed && input.mode === 'scrubbed';

  const steps: HydrateStep[] = [];
  const sql = (
    id: string,
    label: string,
    database: string,
    statement: string,
    extra: Partial<SqlStep> = {},
  ): void => {
    steps.push({
      kind: 'sql',
      id: `${localName}:${id}`,
      label,
      database,
      sql: statement,
      dockerArgv: localPsqlArgv(container, database, statement),
      ...extra,
    });
  };

  // ── 1. staging database (dropped first: a previous failed run may have left one) ──
  sql('staging-drop', `drop any stale staging database ${staging}`, 'postgres', dropDatabaseSql(staging));
  sql('role-ensure', `ensure the service role ${ownerRole} exists`, 'postgres', ensureRoleSql(ownerRole, ownerPw));
  sql(
    'staging-create',
    `create staging database ${staging} owned by ${ownerRole}`,
    'postgres',
    createDatabaseSql(staging, ownerRole),
  );

  // ── 2. the transfer: mirror pg_dump piped straight into a local pg_restore ──
  const dumpArgv = pgDumpArgv({
    mirrorPort: input.mirrorLocalPort,
    user,
    database: def.mirror,
    excludeData: materialise ? real.map((r) => r.table) : [],
  });
  const restoreArgv = pgRestoreArgv({ localPort: input.localPort, staging });
  const pipeline = `${dumpArgv.map(shQuote).join(' ')} | ${restoreArgv.map(shQuote).join(' ')}`;
  steps.push({
    kind: 'transfer',
    id: `${localName}:transfer`,
    label:
      `stream ${def.mirror} → ${staging}` +
      (materialise ? ` (structure only for ${real.length} scrubbed table(s))` : ''),
    dockerArgv: clientRunArgv(image, pipeline),
    shell: pipeline,
    sourceArgv: dumpArgv,
    sinkArgv: restoreArgv,
    needsSecret: true,
    classify: 'pg_restore',
  });

  sql(
    'verify-restored',
    `verify ${staging} is not empty (pg_restore's exit code alone is not proof)`,
    staging,
    restoredSomethingSql(),
    {
      expect: 't',
      expectMessage:
        `${staging} has no relations after the restore (got '%s') — the transfer produced nothing. ` +
        'Live database untouched.',
    },
  );

  // ── 3. the view swap — BOTH modes, opposite meanings, same statement ──
  // real mode:     the `_real` table carries the data; drop the scramble view
  //                and rename the table into the app's expected name.
  // scrubbed mode: the `_real` table arrived EMPTY (its data was excluded), so
  //                the same rename yields a real-shaped, constraint-complete,
  //                WRITABLE table which step 4 then fills from the view.
  // Either way the local result is an ordinary writable table under the app's name.
  for (const { table } of real) {
    sql(
      `view-swap:${table}`,
      `materialise ${table}: drop the scramble view, rename ${table}_real → ${table}`,
      staging,
      viewSwapSql(table),
    );
  }

  // ── 4. scrubbed mode only: COPY the scrambled rows across, column-exact ──
  if (materialise) {
    for (const { table, columns } of real) {
      const src = mirrorPsqlArgv({
        mirrorPort: input.mirrorLocalPort,
        user,
        database: def.mirror,
        sql: copyOutSql(table, columns),
      });
      const sink = localTcpPsqlArgv({
        localPort: input.localPort,
        database: staging,
        sql: copyInSql(table, columns),
      });
      const copyPipeline = `${src.map(shQuote).join(' ')} | ${sink.map(shQuote).join(' ')}`;
      steps.push({
        kind: 'transfer',
        id: `${localName}:copy:${table}`,
        label: `copy scrambled rows for ${table} (${columns.length} column(s))`,
        dockerArgv: clientRunArgv(image, copyPipeline),
        shell: copyPipeline,
        sourceArgv: src,
        sinkArgv: sink,
        needsSecret: true,
        classify: 'psql',
      });
    }
  }

  // ── 5. ownership + grants, then ASSERT both ──
  sql('own', `re-own every object in ${staging} to ${ownerRole}`, staging, ownershipSweepSql(ownerRole));
  sql('grant', `grant tables/sequences/functions + default privileges to ${ownerRole}`, staging, grantSql(ownerRole));
  sql('verify-writable', `verify ${ownerRole} can INSERT into every restored table`, staging, writabilityCheckSql(ownerRole), {
    expect: '0',
    expectMessage:
      `%s public table(s) in ${staging} are NOT writable by ${ownerRole} — the restore would be ` +
      "readable but not writable (an app 500 days later). Live database untouched.",
  });
  if (real.length > 0) {
    sql(
      'verify-tables',
      `verify all ${real.length} app-named relation(s) are ordinary TABLES, not views`,
      staging,
      noViewsCheckSql(real.map((r) => r.table)),
      {
        expect: '0',
        expectMessage:
          `%s app-named relation(s) in ${staging} are still VIEWs — the first local INSERT would fail ` +
          "'cannot insert into view'. Live database untouched.",
      },
    );
  }

  // ── 6. the swap — connected to `postgres`, never to either side ──
  if (localExisted) {
    sql('swap-block', `block new connections to ${localName}`, 'postgres', blockConnectionsSql(localName));
    sql('swap-terminate', `terminate idle backends on ${localName}`, 'postgres', terminateBackendsSql(localName));
    sql('swap-retire', `rename ${localName} → ${retired}`, 'postgres', renameDatabaseSql(localName, retired), {
      retries: 3,
    });
  }
  sql('swap-promote', `rename ${staging} → ${localName}`, 'postgres', renameDatabaseSql(staging, localName));
  sql('swap-unblock', `allow connections to ${localName}`, 'postgres', allowConnectionsSql(localName));
  if (localExisted) {
    if (input.keepPrevious === true) {
      sql('previous-keep', `keep the displaced database as ${retired} (--keep-previous)`, 'postgres', allowConnectionsSql(retired));
    } else {
      sql('previous-drop', `drop the displaced database ${retired}`, 'postgres', dropDatabaseSql(retired));
    }
  }

  return {
    local: def.local,
    localName,
    mirrorName: def.mirror,
    ownerRole,
    scrubbed: def.scrubbed,
    mode: input.mode,
    stagingName: staging,
    retiredName: retired,
    localExisted,
    renamedTables: real.map((r) => r.table),
    copiedTables: materialise ? real.map((r) => r.table) : [],
    steps,
  };
}

/** Build the whole run's plan. PURE — no IO, no clock, no env. */
export function planHydrate(input: HydratePlanInput): HydratePlan {
  return {
    slot: input.slot,
    mode: input.mode,
    pgContainer: input.pgContainer,
    localPort: input.localPort,
    mirrorLocalPort: input.mirrorLocalPort,
    keepPrevious: input.keepPrevious === true,
    clientImage: input.clientImage ?? DEFAULT_CLIENT_IMAGE,
    dbs: input.selection.map((def) => planDb(def, input)),
  };
}

/**
 * THE NON-LOCAL REFUSAL. Hydrate overwrites whole databases, so it must be
 * structurally incapable of pointing at anything but a local synthetic slot.
 *
 * Returns a refusal string, or null when the target is provably local:
 *   - slot 0 is refused outright (the shared baseline; SELECT-only for tooling),
 *   - the container must be exactly the slot's own mesh container — an operator
 *     who has repointed `$SAGA_MESH_POSTGRES_CONTAINER` at something else is
 *     refused rather than obeyed,
 *   - the host must be loopback and the port the slot's derived `5432 + N*1000`.
 */
export function localTargetRefusal(target: {
  slot: number;
  container: string;
  host: string;
  port: number;
}): string | null {
  if (target.slot === 0) {
    return (
      'stack hydrate replaces whole databases and requires an explicit --slot 1..9 or --set <name>. ' +
      'Slot 0 is the shared baseline — hydrating it would destroy live work. ' +
      '(`ss stack cold-start` is the slot-0 reset; there is no --force here.)'
    );
  }
  const expectedContainer = `soa-s${target.slot}-postgres-1`;
  if (target.container !== expectedContainer) {
    return (
      `refusing to hydrate: slot ${target.slot}'s postgres container must be '${expectedContainer}', ` +
      `but resolved to '${target.container}' ($SAGA_MESH_POSTGRES_CONTAINER). ` +
      'Hydrate only ever writes to a local synthetic slot; unset the override and retry.'
    );
  }
  if (target.host !== '127.0.0.1' && target.host !== 'localhost') {
    return (
      `refusing to hydrate: the write target must be loopback, got '${target.host}'. ` +
      'Hydrate only ever writes to a local synthetic slot.'
    );
  }
  const expectedPort = 5432 + target.slot * 1000;
  if (target.port !== expectedPort) {
    return (
      `refusing to hydrate: slot ${target.slot}'s postgres port must be ${expectedPort}, got ${target.port}. ` +
      'Hydrate only ever writes to a local synthetic slot.'
    );
  }
  return null;
}
