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
  SCRUB_PROJECTS,
  findByMirrorName,
  localTargetRefusal,
  mirrorDiscoveryArgv,
  orderByForeignKeys,
  planHydrate,
  realTableQuerySql,
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

  it('marks every mapped database scrubbed except openfga (mirror catalog, 2026-11-09)', () => {
    expect(MIRROR_DATABASES.filter((d) => !d.scrubbed).map((d) => d.mirror)).toEqual(['openfga']);
    expect(MIRROR_DATABASES.filter((d) => d.scrubbed)).toHaveLength(14);
  });

  it('holds a confirmed _real list for exactly the scrubbed databases', () => {
    expect(Object.keys(CONFIRMED_REAL_TABLES).sort()).toEqual(
      MIRROR_DATABASES.filter((d) => d.scrubbed)
        .map((d) => d.mirror)
        .sort(),
    );
    expect(CONFIRMED_REAL_TABLES.ads_adm).toContain('adm_attendance');
    expect(CONFIRMED_REAL_TABLES.iam_db).toHaveLength(17);
  });

  it('assigns each database to one of the iac scrub projects, by the rules package that ships it', () => {
    const owned = (project: string): string[] =>
      MIRROR_DATABASES.filter((d) => d.scrubProject === project)
        .map((d) => d.mirror)
        .sort();
    expect(SCRUB_PROJECTS).toEqual(['rostering', 'program-hub', 'student-data-system', 'coach']);
    expect(owned('rostering')).toEqual(['authz_db', 'authz_sync', 'iam_db', 'iam_pii_db', 'openfga', 'sis_db']);
    expect(owned('program-hub')).toEqual(['content_api', 'programs_api', 'scheduling_api', 'sessions_api']);
    expect(owned('student-data-system')).toEqual(['ads_adm', 'chat', 'ledger_api', 'transcription_db']);
    expect(owned('coach')).toEqual(['coach_api']);
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
    expect(transfer.sourceArgv).toContain('--exclude-table-data=public."users_real"');
    expect(transfer.sourceArgv).toContain('--exclude-table-data=public."groups_real"');
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
    expect(copy.sinkArgv).toContain('COPY public."users_real" ("id", "email", "created_at") FROM STDIN');
    expect(copy.classify).toBe('psql');
  });

  it('copies, then adds constraints, then renames (FKs from data-carrying tables need populated parents)', () => {
    const order = ids(plan());
    const at = (id: string): number => order.indexOf(`iam_local:${id}`);
    expect(at('transfer')).toBeLessThan(at('copy:users'));
    expect(at('copy:users')).toBeLessThan(at('post-data'));
    expect(at('copy:groups')).toBeLessThan(at('post-data'));
    expect(at('post-data')).toBeLessThan(at('view-swap:users'));
    expect(at('post-data')).toBeLessThan(at('view-swap:groups'));
  });

  it('splits the dump: rows without post-data first, then post-data alone', () => {
    const first = transferOf(plan(), 'iam_local:transfer').sourceArgv;
    expect(first).toContain('--section=pre-data');
    expect(first).toContain('--section=data');
    expect(first).not.toContain('--section=post-data');
    const post = transferOf(plan(), 'iam_local:post-data');
    expect(post.sourceArgv).toContain('--section=post-data');
    expect(post.sourceArgv).not.toContain('--section=data');
    // A killed client exits non-zero with empty stderr; that must not read as success.
    expect(post.classify).toBe('psql');
    expect(post.sinkArgv).toContain('--single-transaction');
  });

  it('still asserts nothing is a view when it is done', () => {
    expect(sqlOf(plan(), 'iam_local:verify-tables').expect).toBe('0');
  });

  it('leaves real mode as one whole-database restore', () => {
    const real = db({ mode: 'real' });
    expect(transferOf(real, 'iam_local:transfer').sourceArgv.some((a) => a.startsWith('--section'))).toBe(false);
    expect(ids(real)).not.toContain('iam_local:post-data');
    expect(ids(real)).not.toContain('iam_local:verify-no-real');
  });

  it('does NOT change anything for a database the scrub swaps no table in (openfga)', () => {
    const args = { selection: [findByMirrorName('openfga')!], localExists: { openfga: true }, realTables: {} };
    const asReal = JSON.stringify(planHydrate(input({ ...args, mode: 'real' })).dbs[0]!.steps);
    const asScrubbed = JSON.stringify(planHydrate(input({ ...args, mode: 'scrubbed' })).dbs[0]!.steps);
    expect(asScrubbed).toBe(asReal);
  });
});

describe('--source scrubbed — no row of a _real table is ever copied', () => {
  const plan = (): HydrateDbPlan => db({ mode: 'scrubbed' });
  const transfers = (p: HydrateDbPlan): TransferStep[] => p.steps.filter((s): s is TransferStep => s.kind === 'transfer');

  it('excludes every enumerated _real table from every dump that can carry data', () => {
    const dumps = transfers(plan()).filter(
      (t) => t.sourceArgv[0] === 'pg_dump' && !t.sourceArgv.includes('--section=post-data'),
    );
    expect(dumps).toHaveLength(1);
    for (const { table } of IAM_REAL) {
      expect(dumps[0]!.sourceArgv).toContain(`--exclude-table-data=public."${table}_real"`);
    }
  });

  it('quotes the exclusion so a mixed-case table is matched (pg_dump folds unquoted patterns)', () => {
    const argv = transferOf(
      db({ mode: 'scrubbed', realTables: { iam_db: [{ table: 'Program', columns: ['id'] }] } }),
      'iam_local:transfer',
    ).sourceArgv;
    expect(argv).toContain('--exclude-table-data=public."Program_real"');
  });

  it('excludes *_real by wildcard too, so a table the enumeration missed cannot bring its rows', () => {
    expect(transferOf(plan(), 'iam_local:transfer').sourceArgv).toContain('--exclude-table-data=*.*_real');
  });

  it('never reads a _real table: every COPY source selects from the scramble view', () => {
    const copies = transfers(plan()).filter((t) => t.sourceArgv[0] === 'psql');
    expect(copies).toHaveLength(IAM_REAL.length);
    for (const copy of copies) expect(copy.sourceArgv.join(' ')).not.toMatch(/_real/);
  });

  it('every mirror-side step is one of the three vetted shapes (a new route must be added here on purpose)', () => {
    for (const t of transfers(plan())) {
      const argv = t.sourceArgv;
      const isDataDump = argv[0] === 'pg_dump' && argv.includes('--exclude-table-data=*.*_real');
      const isPostData = argv[0] === 'pg_dump' && argv.includes('--section=post-data') && !argv.includes('--section=data');
      const isViewCopy = argv[0] === 'psql' && !argv.join(' ').includes('_real');
      expect(isDataDump || isPostData || isViewCopy, t.id).toBe(true);
    }
  });

  it('fails the database if any *_real relation survives, before the live database is touched', () => {
    const order = ids(plan());
    const check = sqlOf(plan(), 'iam_local:verify-no-real');
    expect(check.expect).toBe('0');
    expect(check.sql).toContain(`LIKE '%\\_real'`);
    expect(order.indexOf('iam_local:verify-no-real')).toBeLessThan(order.indexOf('iam_local:swap-block'));
  });

  it('holds across every scrubbed database with its confirmed table set', () => {
    for (const def of MIRROR_DATABASES.filter((d) => d.scrubbed)) {
      const tables = CONFIRMED_REAL_TABLES[def.mirror]!;
      const p = planHydrate(
        input({
          mode: 'scrubbed',
          selection: [def],
          localExists: {},
          realTables: { [def.mirror]: tables.map((table) => ({ table, columns: ['id'] })) },
        }),
      ).dbs[0]!;
      const dump = p.steps.find((s) => s.id.endsWith(':transfer')) as TransferStep;
      for (const table of tables) expect(dump.sourceArgv).toContain(`--exclude-table-data=public."${table}_real"`);
      expect(p.copiedTables.slice().sort()).toEqual(tables.slice().sort());
    }
  });
});

describe('foreign-key order for the materialising COPY', () => {
  it('puts parents before children, ties by name', () => {
    const { ordered, cyclic } = orderByForeignKeys(
      ['c', 'b', 'a', 'd'],
      [
        { child: 'a', parent: 'b' },
        { child: 'b', parent: 'c' },
      ],
    );
    expect(ordered).toEqual(['c', 'b', 'a', 'd']);
    expect(cyclic).toEqual([]);
  });

  it('ignores self-references (groups.parent_group_id is one)', () => {
    expect(orderByForeignKeys(['groups', 'users'], [{ child: 'groups', parent: 'groups' }])).toEqual({
      ordered: ['groups', 'users'],
      cyclic: [],
    });
  });

  it('keeps every table when there is a cycle, and names the cycle', () => {
    const { ordered, cyclic } = orderByForeignKeys(
      ['a', 'b', 'x', 'kid'],
      [
        { child: 'a', parent: 'b' },
        { child: 'b', parent: 'a' },
        { child: 'kid', parent: 'x' },
      ],
    );
    expect(ordered).toEqual(['x', 'kid', 'a', 'b']);
    expect(cyclic).toEqual(['a', 'b']);
  });

  it('ignores an edge to a table outside the set', () => {
    expect(orderByForeignKeys(['a'], [{ child: 'a', parent: 'gone' }]).ordered).toEqual(['a']);
  });

  it('drives the plan: parents are copied first, not alphabetically', () => {
    const ordered = db({
      mode: 'scrubbed',
      realTableFks: { iam_db: [{ child: 'groups', parent: 'users' }] },
    });
    expect(ordered.copiedTables).toEqual(['users', 'groups']);
    const order = ids(ordered);
    expect(order.indexOf('iam_local:copy:users')).toBeLessThan(order.indexOf('iam_local:copy:groups'));
  });

  it('leaves generated columns out of the enumeration (COPY refuses them)', () => {
    expect(realTableQuerySql()).toContain(`a.attgenerated = ''`);
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

  it('re-owns sequences after tables (a sequence linked to a table cannot be re-owned first)', () => {
    expect(sqlOf(db(), 'iam_local:own').sql).toContain("ORDER BY c.relkind = 'S', c.oid LOOP");
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
