/**
 * R2 — idempotent DB provisioning fallback (M8 native prep pass).
 *
 * A FAITHFUL port of up.sh's `prep` provisioning fallbacks (up.sh:1048-1068): the
 * idempotent `CREATE DATABASE` for `sessions` (1048-1052) + `content` (1055-1059)
 * and the `DO $$ CREATE ROLE IF NOT EXISTS $$ + CREATE DATABASE … OWNER` for
 * `coach_api` (1061-1067, the #221 blocker). These exist because those DBs/roles
 * are NEWER than pre-existing mesh volumes: Postgres runs `profile-empty.sql`
 * (`/docker-entrypoint-initdb.d`) ONLY on a truly-fresh PGDATA volume, so on any
 * pre-existing volume the newest DBs are simply absent → the fatal seed steps hit
 * a missing DB.
 *
 * This generalizes the up.sh fallback to EVERY mesh-provisioned closure DB (not
 * just sessions/content/coach_api): for each closure DB with `meshProvisioned:true`
 * we ensure its owning role + database exist, idempotently. On a fresh volume
 * (initdb already created them) every DB probes present → all no-ops; on a stale
 * volume the newest ones are created. `coach_api` is included (the named MVP
 * blocker), so the coach soak's manual `CREATE ROLE/DATABASE` step is now native.
 *
 * DEFERRAL NOTE — `ledger_local` is pulled into R2 too (it is `meshProvisioned`):
 * near-zero risk, since profile-empty.sql already `CREATE ROLE ledger` +
 * `CREATE DATABASE ledger_local OWNER ledger` on a FRESH volume — R2 only makes a
 * STALE (pre-ledger) volume match, then R3 dedups its migrate against ads-adm-db.
 *
 * SLOT-AWARE: the psql runs go `docker exec <pgContainer> …` against the resolved
 * slot postgres container (`soa-s<N>-postgres-1` at slot > 0), so provisioning
 * works at any slot.
 *
 * IDEMPOTENT: we probe `pg_database` FIRST and skip a DB that already exists — a
 * re-up on a provisioned stack runs zero psql statements (fast no-op), so wiring
 * this into every native `up` doesn't slow the soaked `--only` path.
 *
 * SEPARATE STATEMENTS (load-bearing): `CREATE DATABASE` cannot run inside a
 * `DO $$…$$` block or a transaction, so the role-ensuring `DO` block and the
 * `CREATE DATABASE` are TWO distinct `psql -c` invocations, not one combined
 * query — the fix already hit in the coach soak.
 *
 * INVARIANT: docker IO lives only in `src/runtime/**`; `src/core/**` never imports
 * this and stays pure. The role/pw/name come from the pure manifest `DatabaseDef`.
 */

import { getDb, manifest as defaultManifest } from '../core/manifest/index.js';
import type { DbId, Manifest } from '../core/manifest/index.js';
import type { Runner } from './exec.js';
import type { PgProbe } from './pg-probe.js';

/** Inputs to the R2 provisioning pass. */
export interface ProvisionContext {
  /** The closure's databases (union of the closure services' `databases`). */
  dbs: DbId[];
  /** Resolved slot postgres container (`soa-postgres-1` at slot 0). */
  pgContainer: string;
  /** Process seam — the `docker exec … psql` statements run through it. */
  runner: Runner;
  /** Read-only probe seam — the `pg_database` existence guard. */
  probe: PgProbe;
  /** Manifest (defaults to the frozen one). */
  manifest?: Manifest;
}

/** What R2 did for one DB. */
export interface ProvisionDbResult {
  db: DbId;
  /**
   * - `created`   — DB was absent; ran the role `DO` block + `CREATE DATABASE`.
   * - `exists`    — DB already present; no statements run (idempotent no-op).
   * - `skipped`   — not a mesh-provisioned postgres DB (mongo / playback trio).
   */
  action: 'created' | 'exists' | 'skipped';
  /** Reason for `skipped` (mongo / not-mesh-provisioned). */
  reason?: string;
}

/** The outcome of the R2 pass. */
export interface ProvisionResult {
  ok: boolean;
  dbs: ProvisionDbResult[];
  /** The DB whose CREATE failed (set only when `ok` is false). */
  failed?: DbId;
}

/** The role-ensuring `DO` block: `CREATE ROLE … LOGIN PASSWORD …` iff the role is absent. */
export function ensureRoleSql(role: string, pw: string): string {
  return (
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') ` +
    `THEN CREATE ROLE ${role} LOGIN PASSWORD '${pw}'; END IF; END $$;`
  );
}

/** The `CREATE DATABASE <name> OWNER <role>` statement (run separately — cannot be in a txn/DO). */
export function createDatabaseSql(name: string, role: string): string {
  return `CREATE DATABASE ${name} OWNER ${role}`;
}

/** `docker exec <container> psql -U postgres_admin -d postgres -c "<sql>"` argv. */
function psqlExecArgs(container: string, sql: string): string[] {
  return ['exec', container, 'psql', '-U', 'postgres_admin', '-d', 'postgres', '-c', sql];
}

/**
 * Provision every mesh-provisioned closure DB idempotently: probe existence, and
 * on absence run the role `DO` block THEN `CREATE DATABASE` (separate statements).
 * Non-postgres (connectv3) and playback (`meshProvisioned:false`) DBs are skipped
 * (the latter are provisioned by the playback bootstrap — R5). Returns a
 * structured result; a failed CREATE stops the pass with `ok:false`.
 */
export async function provisionDbs(ctx: ProvisionContext): Promise<ProvisionResult> {
  const m = ctx.manifest ?? defaultManifest;
  const results: ProvisionDbResult[] = [];

  for (const id of ctx.dbs) {
    const def = getDb(id, m);

    if (def.engine !== 'postgres') {
      results.push({ db: id, action: 'skipped', reason: 'non-postgres (mongo auto-creates)' });
      continue;
    }
    if (!def.meshProvisioned) {
      results.push({ db: id, action: 'skipped', reason: 'not mesh-provisioned (playback bootstrap — R5)' });
      continue;
    }

    // Idempotency guard: an already-present DB (fresh initdb volume, or a prior
    // up) runs ZERO statements — the fast no-op the soaked --only path relies on.
    if (await ctx.probe.databaseExists(ctx.pgContainer, def.name)) {
      results.push({ db: id, action: 'exists' });
      continue;
    }

    // Absent → ensure the role (idempotent DO block), then CREATE DATABASE as a
    // SEPARATE statement (CREATE DATABASE can't run inside the DO/txn).
    const role = await ctx.runner.run({
      cwd: process.cwd(),
      command: 'docker',
      args: psqlExecArgs(ctx.pgContainer, ensureRoleSql(def.ownerRole, def.ownerPw)),
      env: {},
      stdio: 'inherit',
    });
    if (role.code !== 0) return { ok: false, dbs: results, failed: id };

    const create = await ctx.runner.run({
      cwd: process.cwd(),
      command: 'docker',
      args: psqlExecArgs(ctx.pgContainer, createDatabaseSql(def.name, def.ownerRole)),
      env: {},
      stdio: 'inherit',
    });
    if (create.code !== 0) return { ok: false, dbs: results, failed: id };

    results.push({ db: id, action: 'created' });
  }

  return { ok: true, dbs: results };
}
