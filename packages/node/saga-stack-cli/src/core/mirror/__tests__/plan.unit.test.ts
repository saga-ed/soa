/**
 * The `stack hydrate` PLANNER unit tests — the whole point of the pure/executor
 * split. Every assertion here is about exact argv or exact SQL, and not one of
 * them touches a database, a container, a tunnel, or AWS.
 *
 * Pinned, in order of what would hurt most if it broke:
 *   - the mirror→local NAME MAP (a wrong pair restores one service's schema over
 *     another service's database) and its agreement with the manifest,
 *   - the credential shape: no secret in argv, `-e PGPASSWORD` bare,
 *   - REAL mode maps `users_real` → `users`,
 *   - SCRUBBED mode never leaves a view: `--exclude-table-data` for the real
 *     data, the same rename to inherit the constraints, then a column-exact COPY
 *     of the scrambled rows,
 *   - grants + ownership so a service role can WRITE, and the assertion that
 *     proves it,
 *   - the staging→verify→swap ordering (nothing touches the live database until
 *     it is proven good),
 *   - the non-local refusal,
 *   - and the full argv for one representative database.
 */

import { describe, expect, it } from 'vitest';
import { DATABASES } from '../../manifest/index.js';
import {
  CONFIRMED_REAL_TABLES,
  DEFAULT_CLIENT_IMAGE,
  DEFAULT_LOCAL_PORT,
  MIRROR_DATABASES,
  findByMirrorName,
  localTargetRefusal,
  mirrorDiscoveryArgv,
  planHydrate,
  resolveSelection,
  shQuote,
} from '../index.js';
import type { HydrateDbPlan, HydratePlanInput, RealTableInfo, SqlStep, TransferStep } from '../index.js';

const IAM_REAL: RealTableInfo[] = [
  { table: 'users', columns: ['id', 'email', 'created_at'] },
  { table: 'groups', columns: ['id', 'name'] },
];

/** A slot-2 plan input; `over` patches whatever a test is about. */
function input(over: Partial<HydratePlanInput> = {}): HydratePlanInput {
  return {
    slot: 2,
    mode: 'real',
    selection: [findByMirrorName('iam_db')!],
    pgContainer: 'soa-s2-postgres-1',
    localPort: 7432,
    mirrorLocalPort: DEFAULT_LOCAL_PORT,
    localExists: { iam_local: true },
    realTables: { iam_db: IAM_REAL },
    stamp: '20260806T133000Z',
    ...over,
  };
}

const db = (over: Partial<HydratePlanInput> = {}): HydrateDbPlan => planHydrate(input(over)).dbs[0]!;
const ids = (plan: HydrateDbPlan): string[] => plan.steps.map((s) => s.id);
const sqlOf = (plan: HydrateDbPlan, id: string): SqlStep =>
  plan.steps.find((s) => s.id === id && s.kind === 'sql') as SqlStep;
const transferOf = (plan: HydrateDbPlan, id: string): TransferStep =>
  plan.steps.find((s) => s.id === id && s.kind === 'transfer') as TransferStep;

describe('the mirror → local map', () => {
  it('every mapping resolves to a real manifest database (a wrong pair restores over the wrong service)', () => {
    for (const def of MIRROR_DATABASES) {
      expect(DATABASES[def.local], `${def.mirror} → ${def.local}`).toBeDefined();
    }
  });

  it('is not the identity — only coach_api, sis_db and openfga share a name', () => {
    const same = MIRROR_DATABASES.filter((d) => d.mirror === DATABASES[d.local].name).map((d) => d.mirror);
    expect(same.sort()).toEqual(['coach_api', 'openfga', 'sis_db']);
  });

  it('marks exactly the two rostering databases as scrubbed', () => {
    expect(MIRROR_DATABASES.filter((d) => d.scrubbed).map((d) => d.mirror)).toEqual(['iam_db', 'iam_pii_db']);
    expect(Object.keys(CONFIRMED_REAL_TABLES).sort()).toEqual(['iam_db', 'iam_pii_db']);
  });

  it('maps ledger_api to the `ledger` owner, NOT ads_adm (the standing snapshot invariant)', () => {
    expect(DATABASES[findByMirrorName('ledger_api')!.local].ownerRole).toBe('ledger');
    expect(DATABASES[findByMirrorName('ads_adm')!.local].ownerRole).toBe('ads_adm');
  });

  it('resolves a selection by EITHER name, dedups, and keeps report order', () => {
    const picked = resolveSelection(['coach_api', 'iam_local', 'iam_db', 'programs_api']);
    expect(picked.map((d) => d.mirror)).toEqual(['iam_db', 'programs_api', 'coach_api']);
  });

  it('rejects an unknown --db token instead of silently hydrating less', () => {
    expect(() => resolveSelection(['programs'])).not.toThrow(); // the local name is valid
    expect(() => resolveSelection(['programs_db'])).toThrow(/unknown --db 'programs_db'/);
  });

  it('leaves the playback/unverified mappings out of the default set', () => {
    const names = resolveSelection([]).map((d) => d.mirror);
    expect(names).not.toContain('chat');
    expect(names).not.toContain('transcription_db');
    expect(names).not.toContain('openfga');
    expect(names).toContain('iam_db');
    expect(resolveSelection(['all']).map((d) => d.mirror)).toContain('chat');
  });
});

describe('credential hygiene — the secret is never in argv or in the plan', () => {
  it('passes PGPASSWORD as a BARE -e (docker inherits it from the env; argv is world-readable in ps)', () => {
    const plan = db();
    const transfer = transferOf(plan, 'iam_local:transfer');
    expect(transfer.dockerArgv).toContain('-e');
    expect(transfer.dockerArgv[transfer.dockerArgv.indexOf('-e') + 1]).toBe('PGPASSWORD');
    // No `-e PGPASSWORD=<value>` shape anywhere.
    expect(transfer.dockerArgv.some((a) => a.startsWith('PGPASSWORD='))).toBe(false);
    expect(transfer.needsSecret).toBe(true);
  });

  it('never builds a postgres://user:password@… URL (the env-psql shape that would leak)', () => {
    const plan = planHydrate(input({ selection: [...MIRROR_DATABASES], localExists: {} }));
    const everything = JSON.stringify(plan);
    expect(everything).not.toMatch(/postgres(ql)?:\/\/[^"@]*:[^"@]*@/);
    expect(everything).not.toContain('--password');
  });

  it('sets --no-password on every mirror-side client so a missing credential fails fast', () => {
    const transfer = transferOf(db(), 'iam_local:transfer');
    expect(transfer.sourceArgv).toContain('--no-password');
    expect(transfer.sinkArgv).toContain('--no-password');
  });

  it('marks LOCAL-only sql steps as not needing the secret at all', () => {
    for (const step of db().steps) {
      if (step.kind === 'sql') expect(step.needsSecret).toBeUndefined();
    }
  });
});

describe('--source real — the `_real` table becomes the app-named table', () => {
  it('maps users_real → users (and groups_real → groups) with the view dropped FIRST', () => {
    const plan = db({ mode: 'real' });
    const swap = sqlOf(plan, 'iam_local:view-swap:users');
    expect(swap.database).toBe('iam_local__hydrate');
    expect(swap.sql).toBe('DROP VIEW IF EXISTS public."users" CASCADE; ALTER TABLE public."users_real" RENAME TO "users";');
    expect(sqlOf(plan, 'iam_local:view-swap:groups').sql).toContain('ALTER TABLE public."groups_real" RENAME TO "groups"');
    expect(plan.renamedTables).toEqual(['users', 'groups']);
  });

  it('dumps the real data — no --exclude-table-data, and no COPY steps', () => {
    const plan = db({ mode: 'real' });
    expect(transferOf(plan, 'iam_local:transfer').sourceArgv.join(' ')).not.toContain('--exclude-table-data');
    expect(plan.copiedTables).toEqual([]);
    expect(ids(plan).filter((id) => id.includes(':copy:'))).toEqual([]);
  });

  it('asserts afterwards that no app-named relation is still a VIEW', () => {
    const check = sqlOf(db({ mode: 'real' }), 'iam_local:verify-tables');
    expect(check.expect).toBe('0');
    expect(check.sql).toContain(`c.relname IN ('users', 'groups')`);
    expect(check.sql).toContain(`c.relkind NOT IN ('r', 'p')`);
    expect(check.expectMessage).toMatch(/cannot insert into view/);
  });
});

describe('--source scrubbed — the view is MATERIALISED, never left as a view', () => {
  const plan = (): HydrateDbPlan => db({ mode: 'scrubbed' });

  it('excludes the unscrubbed DATA but keeps the _real STRUCTURE (constraints, indexes, defaults)', () => {
    const transfer = transferOf(plan(), 'iam_local:transfer');
    expect(transfer.sourceArgv).toContain('--exclude-table-data=public.users_real');
    expect(transfer.sourceArgv).toContain('--exclude-table-data=public.groups_real');
    // Structure still crosses — this is what makes the result a real writable
    // table rather than a constraint-less CTAS.
    expect(transfer.sourceArgv).not.toContain('--schema-only');
  });

  it('renames the (now empty) _real table into place, so the target keeps its PK/indexes', () => {
    expect(sqlOf(plan(), 'iam_local:view-swap:users').sql).toContain('ALTER TABLE public."users_real" RENAME TO "users"');
  });

  it('copies the SCRAMBLED rows from the mirror view, column-exact in the real table order', () => {
    const copy = transferOf(plan(), 'iam_local:copy:users');
    expect(copy.sourceArgv).toContain('COPY (SELECT "id", "email", "created_at" FROM public."users") TO STDOUT');
    expect(copy.sinkArgv).toContain('COPY public."users" ("id", "email", "created_at") FROM STDIN');
    expect(copy.classify).toBe('psql');
    expect(plan().copiedTables).toEqual(['users', 'groups']);
  });

  it('runs the COPY AFTER the rename (the view is gone by then; the rows come from the mirror)', () => {
    const order = ids(plan());
    expect(order.indexOf('iam_local:view-swap:users')).toBeLessThan(order.indexOf('iam_local:copy:users'));
  });

  it('still asserts nothing is a view when it is done', () => {
    expect(sqlOf(plan(), 'iam_local:verify-tables').expect).toBe('0');
  });

  it('does NOT change anything for a non-scrubbed database — only rostering is scrubbed upstream', () => {
    const args = { selection: [findByMirrorName('coach_api')!], localExists: { coach_api: true }, realTables: {} };
    const asReal = JSON.stringify(planHydrate(input({ ...args, mode: 'real' })).dbs[0]!.steps);
    const asScrubbed = JSON.stringify(planHydrate(input({ ...args, mode: 'scrubbed' })).dbs[0]!.steps);
    expect(asScrubbed).toBe(asReal);
  });
});

describe('ownership + grants — the named silent failure', () => {
  it('restores with --no-owner --no-privileges as the local SUPERUSER, then re-owns to the service role', () => {
    const plan = db();
    const restore = transferOf(plan, 'iam_local:transfer').sinkArgv;
    expect(restore).toContain('--no-owner');
    expect(restore).toContain('--no-privileges');
    expect(restore).toContain('postgres_admin');
    expect(sqlOf(plan, 'iam_local:own').sql).toContain("'iam'");
    expect(sqlOf(plan, 'iam_local:own').sql).toContain('ALTER TABLE %I.%I OWNER TO %I');
    expect(sqlOf(plan, 'iam_local:own').sql).toContain('ALTER SEQUENCE %I.%I OWNER TO %I');
  });

  it('grants tables AND sequences AND functions AND default privileges to the local owner role', () => {
    const grants = sqlOf(db(), 'iam_local:grant').sql;
    expect(grants).toContain('GRANT ALL ON ALL TABLES IN SCHEMA public TO "iam";');
    expect(grants).toContain('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "iam";');
    expect(grants).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "iam";');
  });

  it('creates the staging database OWNED by the service role (so pg_database_owner resolves to it)', () => {
    expect(sqlOf(db(), 'iam_local:staging-create').sql).toBe('CREATE DATABASE "iam_local__hydrate" OWNER "iam"');
  });

  it('ASSERTS the role can INSERT into every restored table — readable-but-not-writable fails the run', () => {
    const check = sqlOf(db(), 'iam_local:verify-writable');
    expect(check.expect).toBe('0');
    expect(check.sql).toContain(`has_table_privilege('iam', c.oid, 'INSERT')`);
    expect(check.expectMessage).toMatch(/NOT writable/);
    expect(check.expectMessage).toMatch(/Live database untouched/);
  });

  it('uses each database’s OWN owner role, not one global role', () => {
    const plan = planHydrate(
      input({
        selection: [findByMirrorName('coach_api')!, findByMirrorName('ledger_api')!, findByMirrorName('programs_api')!],
        localExists: {},
        realTables: {},
      }),
    );
    // Order is the caller's selection order (`resolveSelection` is what normalizes it).
    expect(plan.dbs.map((d) => `${d.localName}:${d.ownerRole}`)).toEqual([
      'coach_api:coach_api_app',
      'ledger_local:ledger',
      'programs:saga_user',
    ]);
  });
});

describe('staging → verify → swap ordering (the live database is never touched until it is proven good)', () => {
  it('runs the whole sequence in order for an EXISTING local database', () => {
    expect(ids(db())).toEqual([
      'iam_local:staging-drop',
      'iam_local:role-ensure',
      'iam_local:staging-create',
      'iam_local:transfer',
      'iam_local:verify-restored',
      'iam_local:view-swap:users',
      'iam_local:view-swap:groups',
      'iam_local:own',
      'iam_local:grant',
      'iam_local:verify-writable',
      'iam_local:verify-tables',
      'iam_local:swap-block',
      'iam_local:swap-terminate',
      'iam_local:swap-retire',
      'iam_local:swap-promote',
      'iam_local:swap-unblock',
      'iam_local:previous-drop',
    ]);
  });

  it('every verification happens BEFORE the first statement that touches the live database', () => {
    const order = ids(db());
    const lastVerify = Math.max(...order.map((id, i) => (id.includes(':verify-') ? i : -1)));
    const firstSwap = order.findIndex((id) => id.startsWith('iam_local:swap-'));
    expect(lastVerify).toBeLessThan(firstSwap);
  });

  it('blocks connections and evicts idle backends before the rename (idle pools block database DDL)', () => {
    const plan = db();
    expect(sqlOf(plan, 'iam_local:swap-block').sql).toBe('ALTER DATABASE "iam_local" WITH ALLOW_CONNECTIONS false');
    expect(sqlOf(plan, 'iam_local:swap-terminate').sql).toContain('pg_terminate_backend(pid)');
    expect(sqlOf(plan, 'iam_local:swap-terminate').sql).toContain('pid <> pg_backend_pid()');
    expect(sqlOf(plan, 'iam_local:swap-retire').sql).toBe(
      'ALTER DATABASE "iam_local" RENAME TO "iam_local__pre_hydrate_20260806T133000Z"',
    );
    // The one genuinely racy step (a backend may not be fully reaped yet).
    expect(sqlOf(plan, 'iam_local:swap-retire').retries).toBe(3);
    expect(sqlOf(plan, 'iam_local:swap-promote').sql).toBe('ALTER DATABASE "iam_local__hydrate" RENAME TO "iam_local"');
  });

  it('runs every database-level statement against `postgres`, never against either side of the swap', () => {
    for (const step of db().steps) {
      if (step.kind !== 'sql') continue;
      if (step.id.includes(':swap-') || step.id.includes('staging-') || step.id.includes('previous-') || step.id.includes('role-ensure')) {
        expect(step.database, step.id).toBe('postgres');
      }
    }
  });

  it('--keep-previous keeps the displaced database (and re-enables connections to it) instead of dropping it', () => {
    const plan = db({ keepPrevious: true });
    expect(ids(plan)).toContain('iam_local:previous-keep');
    expect(ids(plan)).not.toContain('iam_local:previous-drop');
    expect(sqlOf(plan, 'iam_local:previous-keep').sql).toBe(
      'ALTER DATABASE "iam_local__pre_hydrate_20260806T133000Z" WITH ALLOW_CONNECTIONS true',
    );
  });

  it('skips the retire/terminate steps entirely when the local database does not exist yet', () => {
    const plan = db({ localExists: {} });
    expect(plan.localExisted).toBe(false);
    expect(ids(plan).filter((id) => /swap-(block|terminate|retire)|previous-/.test(id))).toEqual([]);
    expect(ids(plan)).toContain('iam_local:swap-promote');
  });

  it('drops a stale staging database from a previous failed run before creating a new one', () => {
    expect(sqlOf(db(), 'iam_local:staging-drop').sql).toBe('DROP DATABASE IF EXISTS "iam_local__hydrate" WITH (FORCE)');
  });

  it("does not trust pg_restore's exit code alone — it proves the staging database is non-empty", () => {
    const check = sqlOf(db(), 'iam_local:verify-restored');
    expect(check.expect).toBe('t');
    expect(check.database).toBe('iam_local__hydrate');
    expect(transferOf(db(), 'iam_local:transfer').classify).toBe('pg_restore');
  });
});

describe('the representative database — exact argv', () => {
  const plan = (): HydrateDbPlan =>
    planHydrate(
      input({ selection: [findByMirrorName('coach_api')!], localExists: { coach_api: true }, realTables: {} }),
    ).dbs[0]!;

  it('pg_dump | pg_restore, byte for byte', () => {
    const transfer = transferOf(plan(), 'coach_api:transfer');
    expect(transfer.sourceArgv).toEqual([
      'pg_dump',
      '--host',
      '127.0.0.1',
      '--port',
      '15532',
      '--username',
      'saga_admin',
      '--dbname',
      'coach_api',
      '--no-password',
      '--format',
      'custom',
    ]);
    expect(transfer.sinkArgv).toEqual([
      'pg_restore',
      '--host',
      '127.0.0.1',
      '--port',
      '7432',
      '--username',
      'postgres_admin',
      '--dbname',
      'coach_api__hydrate',
      '--no-password',
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
    ]);
  });

  it('runs the pipeline in an ephemeral HOST-NETWORKED container under bash -o pipefail', () => {
    const transfer = transferOf(plan(), 'coach_api:transfer');
    expect(transfer.dockerArgv.slice(0, 8)).toEqual([
      'run',
      '--rm',
      '--network',
      'host',
      '-e',
      'PGPASSWORD',
      DEFAULT_CLIENT_IMAGE,
      'bash',
    ]);
    expect(transfer.dockerArgv.slice(8, 10)).toEqual(['-o', 'pipefail']);
    expect(transfer.dockerArgv[10]).toBe('-c');
    expect(transfer.dockerArgv[11]).toBe(transfer.shell);
    expect(transfer.shell).toBe(
      `${transfer.sourceArgv.map(shQuote).join(' ')} | ${transfer.sinkArgv.map(shQuote).join(' ')}`,
    );
  });

  it('drives every LOCAL statement through `docker exec <slot container> psql -U postgres_admin`', () => {
    const create = sqlOf(plan(), 'coach_api:staging-create');
    expect(create.dockerArgv).toEqual([
      'exec',
      'soa-s2-postgres-1',
      'psql',
      '-U',
      'postgres_admin',
      '-v',
      'ON_ERROR_STOP=1',
      '-X',
      '-q',
      '-d',
      'postgres',
      '-tAc',
      'CREATE DATABASE "coach_api__hydrate" OWNER "coach_api_app"',
    ]);
  });

  it('reads the scrub enumeration from the mirror in ONE host-networked psql, ordered by attnum', () => {
    const argv = mirrorDiscoveryArgv({ mirrorPort: 15532, user: 'saga_admin', database: 'iam_db', sql: 'SELECT 1' });
    expect(argv.slice(0, 7)).toEqual(['run', '--rm', '--network', 'host', '-e', 'PGPASSWORD', DEFAULT_CLIENT_IMAGE]);
    expect(argv).toContain('--no-password');
    expect(argv).toContain('ON_ERROR_STOP=1');
    expect(argv[argv.length - 1]).toBe('SELECT 1');
  });
});

describe('the non-local refusal — hydrate can only ever write to a local synthetic slot', () => {
  const local = { slot: 2, container: 'soa-s2-postgres-1', host: '127.0.0.1', port: 7432 };

  it('accepts the slot’s own container/host/port', () => {
    expect(localTargetRefusal(local)).toBeNull();
  });

  it('refuses slot 0 outright and points at cold-start', () => {
    const refusal = localTargetRefusal({ ...local, slot: 0, container: 'soa-postgres-1', port: 5432 });
    expect(refusal).toMatch(/--slot 1\.\.9 or --set/);
    expect(refusal).toMatch(/cold-start/);
    expect(refusal).toMatch(/live work/);
  });

  it('refuses a repointed $SAGA_MESH_POSTGRES_CONTAINER rather than obeying it', () => {
    expect(localTargetRefusal({ ...local, container: 'prod-postgres' })).toMatch(
      /must be 'soa-s2-postgres-1'.*resolved to 'prod-postgres'/s,
    );
  });

  it('refuses a non-loopback host and a port that is not the slot’s derived one', () => {
    expect(localTargetRefusal({ ...local, host: 'db.prod.internal' })).toMatch(/must be loopback/);
    expect(localTargetRefusal({ ...local, port: 5432 })).toMatch(/must be 7432/);
  });
});

describe('shell quoting', () => {
  it('single-quotes and escapes embedded quotes (SQL in a pipeline is not shell-parsed by accident)', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote(`SELECT 'a'`)).toBe(`'SELECT '\\''a'\\'''`);
    expect(shQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });
});
