/**
 * The shared postgres-probe seam for the native prep pass (M8 — R2 provision +
 * R3 migrate).
 *
 * Both the provisioning fallback (`provision.ts`) and the migrate runner
 * (`migrate.ts`) need to ASK the mesh postgres a few yes/no questions before they
 * decide what to run — exactly the `docker exec … psql -tAc "…"` probes up.sh's
 * `prep`/`migrate_db` shell out for:
 *   - does DB `<db>` exist?                        (provision idempotency guard)
 *   - does `<db>` have a `_prisma_migrations` table? (migrate branch: managed)
 *   - how many public tables does `<db>` have?       (migrate branch: empty vs unmanaged)
 *
 * This is IO (docker exec), so it lives in `src/runtime/**` behind an injectable
 * seam: production wires `makeRealPgProbe()` (the ONLY place these read-only psql
 * probes run); unit tests inject a fake that answers from a script, so the
 * provision/migrate PLAN is asserted with NO real docker/postgres.
 *
 * SLOT-AWARE: every method takes the resolved `container` name (the slot's
 * `soa-s<N>-postgres-1` at slot > 0, `soa-postgres-1` at slot 0), so the same
 * probe works against any slot's mesh.
 *
 * NEVER throws — a missing docker / unreachable DB folds into the "safe" answer
 * (false / not-managed), mirroring up.sh's `2>/dev/null` + empty-string handling.
 *
 * INVARIANT (plan hard constraint): docker IO lives only in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

import { execFile } from 'node:child_process';

/**
 * The injectable postgres-probe seam. Three read-only questions, each a single
 * `docker exec <container> psql -U postgres_admin [-d <db>] -tAc "<sql>"`.
 */
export interface PgProbe {
  /** True iff a database named `db` exists (`SELECT 1 FROM pg_database WHERE datname=…`). */
  databaseExists(container: string, db: string): Promise<boolean>;
  /** True iff `db` has a `public._prisma_migrations` table (migration-managed). */
  hasMigrationsTable(container: string, db: string): Promise<boolean>;
  /** Count of `db`'s public tables (`0` ⇒ empty/fresh; `NaN` on a probe error). */
  publicTableCount(container: string, db: string): Promise<number>;
  /**
   * Run an arbitrary read-only scalar query against `db` and return its trimmed
   * single-value output (`''` on any error). Powers the `verify --full` DATA checks
   * (D1/D2/D3 — `count(*) FROM users`, the dev-id probe, admin-persona count). Reads
   * as `postgres_admin` (the mesh superuser); `''` distinguishes an unreachable DB
   * from a legitimate `0`.
   */
  scalar(container: string, db: string, sql: string): Promise<string>;
}

/** Run `docker exec <container> psql …args`, resolving trimmed stdout ('' on any error). NEVER throws. */
function dockerPsql(container: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, 'psql', ...args], { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString().trim());
    });
  });
}

/**
 * The production probe: each method is one `docker exec … psql -tAc`, exactly the
 * queries up.sh's `prep`/`migrate_db` run. Connects as `postgres_admin` (the mesh
 * superuser). Errors fold to the safe answer so a dead container never throws.
 */
export function makeRealPgProbe(): PgProbe {
  return {
    async databaseExists(container: string, db: string): Promise<boolean> {
      const out = await dockerPsql(container, [
        '-U',
        'postgres_admin',
        '-tAc',
        `SELECT 1 FROM pg_database WHERE datname='${db}'`,
      ]);
      return out === '1';
    },
    async hasMigrationsTable(container: string, db: string): Promise<boolean> {
      const out = await dockerPsql(container, [
        '-U',
        'postgres_admin',
        '-d',
        db,
        '-tAc',
        "SELECT to_regclass('public._prisma_migrations') IS NOT NULL",
      ]);
      return out === 't';
    },
    async publicTableCount(container: string, db: string): Promise<number> {
      const out = await dockerPsql(container, [
        '-U',
        'postgres_admin',
        '-d',
        db,
        '-tAc',
        "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
      ]);
      // Empty string (probe error) ⇒ NaN, which the migrate branch treats as
      // "not empty" → unmanaged, exactly like up.sh's `[[ "" == 0 ]]` being false.
      return out === '' ? Number.NaN : Number.parseInt(out, 10);
    },
    scalar(container: string, db: string, sql: string): Promise<string> {
      // `-tAc` = tuples-only, unaligned, single command — a bare scalar, exactly the
      // verify.sh `psql -tAc` DATA reads. Connects as postgres_admin (mesh superuser).
      return dockerPsql(container, ['-U', 'postgres_admin', '-d', db, '-tAc', sql]);
    },
  };
}
