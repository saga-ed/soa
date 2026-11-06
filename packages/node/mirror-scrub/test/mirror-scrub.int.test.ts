import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/mirror-scrub');
const fixture = path.resolve(here, 'fixture');
const schemaSql = readFileSync(path.join(fixture, 'schema.sql'), 'utf8');
const scrubFile = path.join(fixture, 'fixture.scrub.sql');
const allowFile = path.join(fixture, 'fixture.allow.sql');
// Prod runs 18.x (iac dbs/postgres_rds/samconfig.yaml EngineVersion).
const image = process.env.MIRROR_SCRUB_PG_IMAGE ?? 'postgres:18';

let pg: StartedPostgreSqlContainer;
let env: NodeJS.ProcessEnv;
let tmp: string;
let dbSeq = 0;

function psql(db: string, sql: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const r = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-tA', '-d', db, '-c', sql], {
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

function cliRun(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(cli, args, { env: { ...env, ...extraEnv }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
}

function file(name: string, body: string) {
    const p = path.join(tmp, name);
    writeFileSync(p, body);
    return p;
}

/** A fresh database named `fixture_<n>` holding the fixture schema; allow-list rows are rewritten to match. */
function freshDb() {
    const db = `fixture_${++dbSeq}`;
    expect(psql('postgres', `CREATE DATABASE ${db}`).code).toBe(0);
    expect(psql(db, schemaSql).code).toBe(0);
    const allow = file(`${db}.allow.sql`, readFileSync(allowFile, 'utf8').replaceAll("'fixture'", `'${db}'`));
    return { db, allow };
}

const asMaster = { PGOPTIONS: '-c role=mirror_check_master' };

function relkind(db: string, rel: string) {
    return psql(db, `SELECT relkind FROM pg_class WHERE relname = '${rel}' AND relnamespace = 'public'::regnamespace`).out;
}

/** freshDb with every fixture table owned by mirror_check_owner, ready for `run` as mirror_check_master. */
function ownedDb() {
    const { db, allow } = freshDb();
    expect(
        psql(
            db,
            `GRANT USAGE, CREATE ON SCHEMA public TO mirror_check_master;
             ALTER TABLE person OWNER TO mirror_check_owner; ALTER TABLE outbox_event OWNER TO mirror_check_owner;
             ALTER TABLE org OWNER TO mirror_check_owner; ALTER VIEW person_emails OWNER TO mirror_check_owner;
             ALTER MATERIALIZED VIEW person_counts OWNER TO mirror_check_owner;`,
        ).code,
    ).toBe(0);
    return { db, allow };
}

beforeAll(async () => {
    pg = await new PostgreSqlContainer(image).start();
    env = {
        ...process.env,
        PGHOST: pg.getHost(),
        PGPORT: String(pg.getPort()),
        PGUSER: pg.getUsername(),
        PGPASSWORD: pg.getPassword(),
        PGOPTIONS: '',
    };
    tmp = mkdtempSync(path.join(tmpdir(), 'mirror-scrub-'));
});

afterAll(async () => {
    await pg?.stop();
});

describe('mirror-scrub check', () => {
    it('refuses without MIRROR_SCRUB_THROWAWAY=1', () => {
        const { db, allow } = freshDb();
        const r = cliRun(['check', '--db', db, '--scrub', scrubFile, '--allow', allow]);
        expect(r.code).toBe(2);
        expect(relkind(db, 'person')).toBe('r');
    });

    it('passes on the fixture, runs twice, and leaves RDS-shaped grants locked', () => {
        const { db, allow } = freshDb();
        const matrix = path.join(tmp, `${db}.matrix`);
        const r = cliRun(['check', '--db', db, '--scrub', scrubFile, '--allow', allow, '--matrix', matrix], {
            MIRROR_SCRUB_THROWAWAY: '1',
        });
        expect(r.out).toContain('already swapped');
        expect(r.code, r.out).toBe(0);

        const m = readFileSync(matrix, 'utf8');
        for (const col of ['person.email', 'person.full_name', 'person.note', 'person.tags', 'outbox_event.payload']) {
            expect(m).toContain(`${db}.${col} SCRUBBED`);
        }
        expect(m).toContain(`${db}.person.id PASS`);

        const ro = { PGOPTIONS: '-c role=mirror_check_ro' };
        expect(psql(db, 'SELECT count(*) FROM person', ro).out).toBe('2');
        expect(psql(db, 'SELECT count(*) FROM person_real', ro).err).toContain('permission denied');
        expect(psql(db, 'SELECT count(*) FROM person_emails', ro).err).toContain('permission denied');
        expect(psql(db, "SELECT count(*) FROM person WHERE email LIKE 'REAL_%'", ro).out).toBe('0');
        // The per-table column grant (attnum 1) moved from person_real to the view.
        expect(
            psql(db, "SELECT has_column_privilege('mirror_check_ro', 'person', 'id', 'SELECT')").out,
        ).toBe('t');
        expect(
            psql(db, "SELECT count(*) FROM pg_attribute WHERE attrelid = 'person_real'::regclass AND attacl IS NOT NULL").out,
        ).toBe('0');
        expect(psql(db, "SELECT relispopulated FROM pg_class WHERE relname = 'person_counts'").out).toBe('f');
    });

    it('exits 10 for a text column that is neither scrubbed nor allow-listed', () => {
        const { db, allow } = freshDb();
        expect(psql(db, 'ALTER TABLE org ADD COLUMN contact_name text').code).toBe(0);
        const r = cliRun(['check', '--db', db, '--scrub', scrubFile, '--allow', allow], { MIRROR_SCRUB_THROWAWAY: '1' });
        expect(r.code).toBe(10);
        expect(r.out).toContain(`UNREVIEWED COLUMN ${db} .org.contact_name`);
    });

    it('fails closed on non-text types that can carry personal data (inet, xml, composite, domain)', () => {
        const { db, allow } = freshDb();
        expect(
            psql(
                db,
                `CREATE DOMAIN contact_email AS text; CREATE TYPE addr AS (street text, zip int);
                 ALTER TABLE org ADD COLUMN last_ip inet, ADD COLUMN profile xml, ADD COLUMN mail_to addr,
                   ADD COLUMN owner_email contact_email, ADD COLUMN size_n numeric, ADD COLUMN ok boolean;`,
            ).code,
        ).toBe(0);
        const r = cliRun(['check', '--db', db, '--scrub', scrubFile, '--allow', allow], { MIRROR_SCRUB_THROWAWAY: '1' });
        expect(r.code).toBe(10);
        for (const col of ['last_ip', 'profile', 'mail_to', 'owner_email']) {
            expect(r.out).toContain(`UNREVIEWED COLUMN ${db} .org.${col}`);
        }
        expect(r.out).not.toContain('.org.size_n');
        expect(r.out).not.toContain('.org.ok');
    });

    it('exits 20 when the database is missing', () => {
        const r = cliRun(['check', '--db', 'no_such_db', '--scrub', scrubFile, '--allow', allowFile], {
            MIRROR_SCRUB_THROWAWAY: '1',
        });
        expect(r.code).toBe(20);
    });
});

describe('mirror-scrub run (exit-code contract)', () => {
    beforeAll(() => {
        // Roles as check creates them, so `run` can be exercised as a non-superuser master.
        const { db, allow } = freshDb();
        expect(cliRun(['check', '--db', db, '--scrub', scrubFile, '--allow', allow], { MIRROR_SCRUB_THROWAWAY: '1' }).code).toBe(0);
    });

    it('exits 0 and commits on a clean scrub', () => {
        const { db, allow } = ownedDb();
        const r = cliRun(['run', '--db', db, '--scrub', scrubFile, '--allow', allow], asMaster);
        expect(r.code, r.out).toBe(0);
        expect(relkind(db, 'person')).toBe('v');
        expect(relkind(db, 'person_real')).toBe('r');
    });

    it('exits 20 and rolls back when an override names a dropped column', () => {
        const { db, allow } = ownedDb();
        const bad = file(`${db}.scrub.sql`, `${readFileSync(scrubFile, 'utf8')}
SELECT pg_temp.mirror_scrub('public', 'org', jsonb_build_object('gone', $e$NULL$e$));\n`);
        const r = cliRun(['run', '--db', db, '--scrub', bad, '--allow', allow], asMaster);
        expect(r.code).toBe(20);
        expect(r.out).toContain('has no column(s) {gone}');
        expect(relkind(db, 'person')).toBe('r');
        expect(relkind(db, 'person_real')).toBe('');
    });

    it('exits 20 when a required table is missing, and skips an optional one', () => {
        const { db, allow } = ownedDb();
        const required = file(`${db}.req.sql`, "SELECT pg_temp.mirror_scrub('public', 'nope', '{}'::jsonb);\n");
        expect(cliRun(['run', '--db', db, '--scrub', required, '--allow', allow], asMaster).code).toBe(20);
        const optional = file(
            `${db}.opt.sql`,
            `${readFileSync(scrubFile, 'utf8')}SELECT pg_temp.mirror_scrub('public', 'nope', '{}'::jsonb, false);\n`,
        );
        const r = cliRun(['run', '--db', db, '--scrub', optional, '--allow', allow], asMaster);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('skipped (optional)');
    });

    it('exits 20 when the master is not a member of the table owner', () => {
        const { db, allow } = ownedDb();
        expect(
            psql('postgres', "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foreign_owner') THEN CREATE ROLE foreign_owner NOLOGIN; END IF; END $$").code,
        ).toBe(0);
        expect(psql(db, 'ALTER TABLE person OWNER TO foreign_owner').code).toBe(0);
        const r = cliRun(['run', '--db', db, '--scrub', scrubFile, '--allow', allow], asMaster);
        expect(r.code).toBe(20);
        expect(r.out).toContain('must be a member of the owner role');
        expect(relkind(db, 'outbox_event')).toBe('r');
    });

    it('exits 20 for an absent database, 30 with --allow-absent', () => {
        expect(cliRun(['run', '--db', 'absent_db', '--scrub', scrubFile, '--allow', allowFile], asMaster).code).toBe(20);
        expect(
            cliRun(['run', '--db', 'absent_db', '--scrub', scrubFile, '--allow', allowFile, '--allow-absent'], asMaster).code,
        ).toBe(30);
    });
});

describe('mirror-scrub run: default drop', () => {
    const ownerObjs = (db: string, ddl: string, owned: string[], viewsOwned: string[] = []) => {
        const alters = owned.map((o) => `ALTER TABLE ${o} OWNER TO mirror_check_owner;`).join('\n');
        const v = viewsOwned.map((o) => `ALTER ${o.startsWith('MV ') ? 'MATERIALIZED VIEW ' + o.slice(3) : 'VIEW ' + o} OWNER TO mirror_check_owner;`).join('\n');
        expect(psql(db, `${ddl}\n${alters}\n${v}`).code).toBe(0);
    };
    const allowMore = (allow: string, db: string, rows: string) =>
        writeFileSync(allow, `${readFileSync(allow, 'utf8')}\nINSERT INTO pg_temp.mirror_allow (db, tbl, col) VALUES ${rows.replaceAll('DB', `'${db}'`)};\n`);
    const runDrop = (db: string, allow: string, extra: string[] = [], env: NodeJS.ProcessEnv = asMaster) => {
        const dir = path.join(tmp, `${db}-report-${Math.random().toString(36).slice(2)}`);
        const r = cliRun(['run', '--db', db, '--scrub', scrubFile, '--allow', allow, '--report-dir', dir, ...extra], env);
        const jf = path.join(dir, `${db}.mirror-scrub.json`);
        let report: any = null;
        try { report = JSON.parse(readFileSync(jf, 'utf8')); } catch { /* none written */ }
        return { ...r, report, dir };
    };
    /** Every remaining relation (not a *_real table) must not show the leak marker in any row. */
    const leakCount = (db: string) => {
        const q = `DO $d$ DECLARE r record; n bigint; t bigint := 0; BEGIN
          FOR r IN SELECT n.nspname s, c.relname c FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relkind IN ('r','v','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
                      AND c.relname !~ '_real$' AND (c.relkind <> 'm' OR c.relispopulated) LOOP
            EXECUTE format('SELECT count(*) FROM %I.%I x WHERE x::text LIKE %L', r.s, r.c, '%LEAK\\_%') INTO n; t := t + n;
          END LOOP; RAISE EXCEPTION 'LEAKS=%', t; END $d$`;
        const e = psql(db, q).err; return /LEAKS=(\d+)/.exec(e)?.[1] ?? e;
    };

    it('drops an unreviewed table whose columns are all exempt types (exit 12) and reports it', () => {
        const { db, allow } = ownedDb();
        ownerObjs(db, "CREATE TABLE audit_log (id uuid DEFAULT gen_random_uuid(), n int); INSERT INTO audit_log (n) VALUES (1), (2);", ['audit_log']);
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'audit_log')).toBe('');
        expect(relkind(db, 'person')).toBe('v');
        const d = r.report.dropped.find((x: any) => x.table === 'audit_log');
        expect(d.reason).toBe('unreviewed_table');
        expect(r.report.status).toBe('dropped');
        expect(r.report.exit_code).toBe(12);
        expect(readFileSync(path.join(r.dir, `${db}.mirror-scrub.md`), 'utf8')).toContain('audit_log');
        expect(r.out).toContain('MIRROR_SCRUB_REPORT_BEGIN');
    });

    it('an unreviewed column on a swapped table drops view and real table; dependents and FK are reported; referencing rows survive; no raw data remains', () => {
        const { db, allow } = ownedDb();
        allowMore(allow, db, "(DB, 'enrollment', '*')");
        ownerObjs(
            db,
            `ALTER TABLE person ADD COLUMN ssn text; UPDATE person SET ssn = 'LEAK_ssn';
             INSERT INTO person (email, full_name) VALUES ('REAL_a', 'REAL_b'), ('REAL_c', 'REAL_d');
             CREATE TABLE enrollment (id serial PRIMARY KEY, person_id uuid REFERENCES person(id));
             INSERT INTO enrollment (person_id) SELECT id FROM person;
             INSERT INTO org (code) VALUES ('ok');`,
            ['enrollment'],
        );
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'person')).toBe('');
        expect(relkind(db, 'person_real')).toBe('');
        const d = r.report.dropped.find((x: any) => x.table === 'person');
        expect(d.swapped).toBe(true);
        expect(d.reason).toBe('unreviewed_column');
        expect(d.columns).toEqual(['ssn']);
        const names = d.cascade.map((c: any) => `${c.kind}:${c.name}`);
        expect(names).toEqual(expect.arrayContaining(['view:person_emails', 'matview:person_counts', 'view:person']));
        const fk = d.cascade.find((c: any) => c.kind === 'fk_constraint');
        expect(fk.table).toBe('enrollment');
        expect(fk.columns).toEqual(['person_id']);
        expect(psql(db, 'SELECT count(*) FROM enrollment').out).toBe('2');
        expect(readFileSync(path.join(r.dir, `${db}.mirror-scrub.md`), 'utf8')).toContain('Dangling FKs');
        expect(leakCount(db)).toBe('0');
        // The post-commit audit agrees nothing is left.
        expect(r.out).toContain(`MIRROR_SCRUB_UNREVIEWED ${db} 0`);
    });

    it('an unreviewed column on an allow-listed unswapped table drops that table', () => {
        const { db, allow } = ownedDb();
        ownerObjs(db, "ALTER TABLE org ADD COLUMN contact_name text; INSERT INTO org (code, contact_name) VALUES ('a', 'LEAK_name');", []);
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'org')).toBe('');
        expect(r.report.dropped.find((x: any) => x.table === 'org').columns).toEqual(['contact_name']);
        expect(leakCount(db)).toBe('0');
    });

    it('keeps infra tables and marked tables, drops unlisted migration-like tables and marked tables with unreviewed text', () => {
        const { db, allow } = ownedDb();
        allowMore(allow, db, "(DB, 'tag_link', '*'), (DB, 'marked_text', '*')");
        ownerObjs(
            db,
            `CREATE TABLE _prisma_migrations (id text, logs text); CREATE TABLE goose_db_version (id int, version_id bigint, is_applied boolean);
             CREATE TABLE schema_migrations (version text); CREATE TABLE tag_link (a uuid, b uuid);
             CREATE TABLE marked_text (a uuid, note text);
             INSERT INTO _prisma_migrations VALUES ('x', 'LEAK_log');`,
            ['_prisma_migrations', 'goose_db_version', 'schema_migrations', 'tag_link', 'marked_text'],
        );
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, '_prisma_migrations')).toBe('r');
        expect(relkind(db, 'goose_db_version')).toBe('r');
        expect(relkind(db, 'tag_link')).toBe('r');
        expect(relkind(db, 'schema_migrations')).toBe('');
        expect(relkind(db, 'marked_text')).toBe('');
        expect(r.report.infra_allowlisted).toEqual(expect.arrayContaining(['public._prisma_migrations', 'public.goose_db_version']));
    });

    it('drops partitioned roots with children, unlogged tables, populated unknown matviews and unknown non-public tables, and spares the same name in public', () => {
        const { db, allow } = ownedDb();
        ownerObjs(
            db,
            `CREATE TABLE ev (id uuid, at timestamptz) PARTITION BY RANGE (at);
             CREATE TABLE ev_1 PARTITION OF ev FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
             CREATE UNLOGGED TABLE ul (id int);
             CREATE MATERIALIZED VIEW mv_x AS SELECT 1 AS n;
             CREATE SCHEMA other; GRANT USAGE, CREATE ON SCHEMA other TO mirror_check_master;
             CREATE TABLE other.org (id int);
             ALTER TABLE other.org OWNER TO mirror_check_owner;`,
            ['ev', 'ev_1', 'ul'],
            ['MV mv_x'],
        );
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        for (const t of ['ev', 'ev_1', 'ul', 'mv_x']) expect(relkind(db, t)).toBe('');
        expect(psql(db, "SELECT count(*) FROM pg_class WHERE relname = 'org' AND relnamespace = 'other'::regnamespace").out).toBe('0');
        expect(relkind(db, 'org')).toBe('r');
        const ev = r.report.dropped.find((x: any) => x.table === 'ev');
        expect(ev.relkind).toBe('p');
        expect(ev.cascade.some((c: any) => c.kind === 'partition' && c.name === 'ev_1')).toBe(true);
        expect(r.report.dropped.find((x: any) => x.table === 'mv_x').reason).toBe('unreviewed_matview');
    });

    it('(a) CASCADE removes a dependent view owned by a role the master is not a member of', () => {
        const { db, allow } = ownedDb();
        expect(psql('postgres', "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foreign_owner') THEN CREATE ROLE foreign_owner NOLOGIN; END IF; END $$").code).toBe(0);
        ownerObjs(db, 'CREATE TABLE ghost (id uuid); CREATE VIEW ghost_v AS SELECT id FROM ghost; ALTER VIEW ghost_v OWNER TO foreign_owner;', ['ghost']);
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'ghost')).toBe('');
        expect(relkind(db, 'ghost_v')).toBe('');
        expect(r.report.dropped[0].cascade.some((c: any) => c.kind === 'view' && c.name === 'ghost_v')).toBe(true);
    });

    it('(b) large objects fail closed: exit 20 and nothing is committed', () => {
        const { db, allow } = ownedDb();
        expect(psql(db, 'SELECT lo_create(0)').code).toBe(0);
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(20);
        expect(r.out).toContain('large object');
        expect(relkind(db, 'person')).toBe('r');
        expect(relkind(db, 'person_real')).toBe('');
    });

    it('an extension-owned relation with an unreviewed column cannot be dropped: exit 20, nothing dropped', () => {
        const { db, allow } = ownedDb();
        ownerObjs(db, "CREATE EXTENSION IF NOT EXISTS hstore; CREATE TABLE ext_t (a uuid, note text); CREATE TABLE audit_log2 (id int);", ['ext_t', 'audit_log2']);
        const mark = psql(
            db,
            "INSERT INTO pg_depend VALUES ('pg_class'::regclass, 'ext_t'::regclass, 0, 'pg_extension'::regclass, (SELECT oid FROM pg_extension WHERE extname = 'hstore'), 0, 'e')",
        );
        expect(mark.err).toBe('');
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(20);
        expect(relkind(db, 'audit_log2')).toBe('r');
        expect(relkind(db, 'person')).toBe('r');
    });

    it('--dry-run exits 40, rolls back every change and still reports', () => {
        const { db, allow } = ownedDb();
        ownerObjs(db, 'CREATE TABLE audit_log (id int);', ['audit_log']);
        const r = runDrop(db, allow, ['--dry-run']);
        expect(r.code, r.out).toBe(40);
        expect(relkind(db, 'audit_log')).toBe('r');
        expect(relkind(db, 'person')).toBe('r');
        expect(relkind(db, 'person_real')).toBe('');
        expect(r.report.status).toBe('dry_run');
        expect(r.report.would_drop.map((x: any) => x.table)).toContain('audit_log');
    });

    it('--on-unreviewed keep needs a bounded, current escape hatch; with one it exits 10, drops nothing and says so', () => {
        const { db, allow } = ownedDb();
        ownerObjs(db, 'CREATE TABLE audit_log (id int);', ['audit_log']);
        const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
        expect(runDrop(db, allow, ['--on-unreviewed', 'keep']).code).toBe(2);
        expect(runDrop(db, allow, ['--on-unreviewed', 'keep', '--keep-until', day(-1), '--keep-ref', 'iac#1']).code).toBe(2);
        expect(runDrop(db, allow, ['--on-unreviewed', 'keep', '--keep-until', day(30), '--keep-ref', 'iac#1']).code).toBe(2);
        expect(relkind(db, 'audit_log')).toBe('r');
        expect(relkind(db, 'person')).toBe('r');
        const r = runDrop(db, allow, ['--on-unreviewed', 'keep', '--keep-until', day(7), '--keep-ref', 'iac#1002']);
        expect(r.code, r.out).toBe(10);
        expect(r.out).toContain('ESCAPE HATCH ACTIVE');
        expect(relkind(db, 'audit_log')).toBe('r');
        expect(r.report.status).toBe('kept_raw');
        expect(r.report.escape_hatch.active).toBe(true);
        expect(r.report.left_raw.map((x: any) => x.table)).toContain('audit_log');
    });

    it('check never drops: an unreviewed exempt-only table fails with 10 and stays', () => {
        const { db, allow } = freshDb();
        expect(psql(db, 'CREATE TABLE audit_log (id int)').code).toBe(0);
        const r = cliRun(['check', '--db', db, '--scrub', scrubFile, '--allow', allow], { MIRROR_SCRUB_THROWAWAY: '1' });
        expect(r.code, r.out).toBe(10);
        expect(r.out).toContain(`UNREVIEWED TABLE ${db} .public.audit_log`);
        expect(relkind(db, 'audit_log')).toBe('r');
    });

    it('rewrites the report to exit 11 when the post-commit audit disagrees with the in-transaction audit', () => {
        const { db, allow } = ownedDb();
        // Reports 0 large objects while the transaction holds an xid (in-txn audit) and 1 afterwards.
        const flaky = file(
            `${db}.flaky.sql`,
            `${readFileSync(scrubFile, 'utf8')}
CREATE OR REPLACE FUNCTION pg_temp.mirror_large_objects() RETURNS bigint LANGUAGE sql AS $f$
  SELECT CASE WHEN txid_current_if_assigned() IS NULL THEN 1 ELSE 0 END $f$;\n`,
        );
        const dir = path.join(tmp, `${db}-flaky`);
        const r = cliRun(['run', '--db', db, '--scrub', flaky, '--allow', allow, '--report-dir', dir], asMaster);
        expect(r.code, r.out).toBe(11);
        const rep = JSON.parse(readFileSync(path.join(dir, `${db}.mirror-scrub.json`), 'utf8'));
        expect(rep.exit_code).toBe(11);
        expect(rep.status).toBe('audit_incomplete');
        expect(rep.post_commit_audit).toMatchObject({ agrees: false, unreviewed: 1 });
        expect(readFileSync(path.join(dir, `${db}.mirror-scrub.md`), 'utf8')).toContain('exit 11');
    });

    it('does not trust prod-supplied "mirror-scrub:" comments: a commented base table with an unreviewed column is dropped', () => {
        const { db, allow } = ownedDb();
        allowMore(allow, db, "(DB, 'trap', '*')");
        ownerObjs(db, "CREATE TABLE trap (a uuid, note text); COMMENT ON TABLE trap IS 'mirror-scrub:x'; CREATE TABLE trap2 (a int); COMMENT ON TABLE trap2 IS 'mirror-scrub:';", ['trap', 'trap2']);
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'trap')).toBe('');
        expect(relkind(db, 'trap2')).toBe('');
    });

    it('foreign tables: unknown ones drop, known ones with an unreviewed text column drop too', () => {
        const { db, allow } = ownedDb();
        allowMore(allow, db, "(DB, 'ft_known', '*')");
        expect(
            psql(db, `CREATE EXTENSION file_fdw; CREATE SERVER s FOREIGN DATA WRAPPER file_fdw;
              CREATE FOREIGN TABLE ft_unknown (a int) SERVER s OPTIONS (filename '/etc/hostname');
              CREATE FOREIGN TABLE ft_known (a int, note text) SERVER s OPTIONS (filename '/etc/hostname');
              ALTER FOREIGN TABLE ft_unknown OWNER TO mirror_check_owner; ALTER FOREIGN TABLE ft_known OWNER TO mirror_check_owner;`).code,
        ).toBe(0);
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'ft_unknown')).toBe('');
        expect(relkind(db, 'ft_known')).toBe('');
        expect(r.report.dropped.find((x: any) => x.table === 'ft_known').reason).toBe('unreviewed_column');
    });

    it('the infra allowlist is public base tables only: other_schema._prisma_migrations with text is dropped', () => {
        const { db, allow } = ownedDb();
        ownerObjs(
            db,
            `CREATE TABLE _prisma_migrations (id text); CREATE SCHEMA other2; GRANT USAGE, CREATE ON SCHEMA other2 TO mirror_check_master;
             CREATE TABLE other2._prisma_migrations (id text, logs text); ALTER TABLE other2._prisma_migrations OWNER TO mirror_check_owner;`,
            ['_prisma_migrations'],
        );
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, '_prisma_migrations')).toBe('r');
        expect(psql(db, "SELECT count(*) FROM pg_class WHERE relname = '_prisma_migrations' AND relnamespace = 'other2'::regnamespace").out).toBe('0');
    });

    it('fails closed (exit 20, nothing committed) when the drop would silently remove a policy or trigger on a retained table', () => {
        const { db, allow } = ownedDb();
        allowMore(allow, db, "(DB, 'kept', '*')");
        ownerObjs(
            db,
            `CREATE TABLE ghost2 (id uuid); CREATE TABLE kept (a uuid);
             ALTER TABLE kept ENABLE ROW LEVEL SECURITY;
             CREATE POLICY p ON kept USING (EXISTS (SELECT 1 FROM ghost2 WHERE ghost2.id = kept.a));`,
            ['ghost2', 'kept'],
        );
        const r = runDrop(db, allow);
        expect(r.code, r.out).toBe(20);
        expect(relkind(db, 'ghost2')).toBe('r');
        expect(relkind(db, 'person')).toBe('r');
        expect(r.report.left_raw.find((x: any) => x.table === 'ghost2').undroppable).toBe(true);
        expect(r.report.left_raw[0].cascade.some((c: any) => c.kind === 'policy')).toBe(true);
    });

    it('a second run on an already-dropped database is a clean no-op when the rules do not name the dropped table', () => {
        const { db, allow } = ownedDb();
        ownerObjs(db, 'ALTER TABLE org ADD COLUMN contact_name text;', []);
        expect(runDrop(db, allow).code).toBe(12);
        const again = runDrop(db, allow);
        expect(again.code, again.out).toBe(0);
        expect(again.report.status).toBe('clean');
    });
});

describe('mirror-scrub lint', () => {
    it.each([
        ['\\c other_db\n'],
        ["SELECT 1;\n\\i '/tmp/x.sql'\n"],
        ['SELECT 1 \\gexec\n'],
        ["SELECT 'x'\\gexec\n"],
        ["SELECT pg_temp.mirror_scrub('public', 't', '{}'::jsonb);\\! id\n"],
        ['COMMIT;\n'],
        ["SELECT pg_temp.mirror_scrub('public', 't', '{}'::jsonb); commit;\n"],
        ['BEGIN WORK;\n'],
        ['SET ROLE postgres;\n'],
    ])('rejects %j', (body) => {
        const f = file(`lint-${Math.random().toString(36).slice(2)}.sql`, body);
        expect(cliRun(['lint', f]).code).toBe(2);
    });

    it('accepts CASE ... END inside an override expression', () => {
        const f = file(
            'lint-ok.sql',
            `SELECT pg_temp.mirror_scrub('public', 'person', jsonb_build_object(
  'kind', $e$CASE WHEN kind = 'staff' THEN 'staff'
  ELSE 'student'
  END$e$));\n`,
        );
        const r = cliRun(['lint', f, scrubFile, allowFile]);
        expect(r.code, r.out).toBe(0);
    });
});

// Last: creating rds_superuser makes `check` refuse this cluster.
describe('mirror-scrub run on an RDS-shaped master', () => {
    it('adopts a service owner role it is not a member of, via rds_superuser', () => {
        // RDS: the master is NOSUPERUSER, inherits rds_superuser, and holds no membership in
        // service owner roles; vanilla PG needs ADMIN (no INHERIT/SET) to stand in for RDS's grant right.
        expect(
            psql(
                'postgres',
                `CREATE ROLE rds_superuser NOLOGIN;
                 CREATE ROLE rds_master LOGIN NOSUPERUSER CREATEROLE;
                 GRANT rds_superuser TO rds_master;
                 CREATE ROLE svc_owner NOLOGIN;
                 CREATE ROLE rds_iam NOLOGIN;
                 GRANT rds_iam TO svc_owner;
                 GRANT svc_owner TO rds_master WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;`,
            ).code,
        ).toBe(0);
        const { db, allow } = freshDb();
        expect(
            psql(
                db,
                `GRANT USAGE, CREATE ON SCHEMA public TO rds_master;
                 ALTER TABLE person OWNER TO svc_owner; ALTER TABLE outbox_event OWNER TO svc_owner;
                 ALTER TABLE org OWNER TO svc_owner; ALTER VIEW person_emails OWNER TO svc_owner;
                 ALTER MATERIALIZED VIEW person_counts OWNER TO svc_owner;`,
            ).code,
        ).toBe(0);
        expect(psql(db, "SELECT pg_has_role('rds_master', 'svc_owner', 'USAGE')").out).toBe('f');

        const r = cliRun(['run', '--db', db, '--scrub', scrubFile, '--allow', allow], { PGOPTIONS: '-c role=rds_master' });
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('granted svc_owner to rds_master (rds_superuser adopt)');
        expect(r.out).toContain('revoked svc_owner from rds_master (adopt released)');
        expect(relkind(db, 'person')).toBe('v');
        expect(psql(db, "SELECT relowner::regrole FROM pg_class WHERE relname = 'person_real'").out).toBe('rds_master');
        // On RDS an inherited rds_iam forces IAM auth on the master: no adopted grant may persist.
        // (The setup's ADMIN-only row stands in for RDS's grant right; only it may remain.)
        expect(
            psql(
                db,
                `SELECT count(*), bool_or(inherit_option), pg_has_role('rds_master', 'rds_iam', 'USAGE')
                   FROM pg_auth_members WHERE roleid = 'svc_owner'::regrole AND member = 'rds_master'::regrole`,
            ).out,
        ).toBe('1|f|f');

        const again = freshDb();
        expect(
            psql(
                again.db,
                `GRANT USAGE, CREATE ON SCHEMA public TO rds_master;
                 ALTER TABLE person OWNER TO svc_owner; ALTER TABLE outbox_event OWNER TO svc_owner;
                 ALTER TABLE org OWNER TO svc_owner; ALTER VIEW person_emails OWNER TO svc_owner;
                 ALTER MATERIALIZED VIEW person_counts OWNER TO svc_owner;`,
            ).code,
        ).toBe(0);
        const r2 = cliRun(['run', '--db', again.db, '--scrub', scrubFile, '--allow', again.allow], { PGOPTIONS: '-c role=rds_master' });
        expect(r2.code, r2.out).toBe(0);
    });
    it('drops an unreviewed table owned by a role it must adopt, then releases the grant', () => {
        const { db, allow } = freshDb();
        expect(
            psql(
                db,
                `GRANT USAGE, CREATE ON SCHEMA public TO rds_master;
                 ALTER TABLE person OWNER TO svc_owner; ALTER TABLE outbox_event OWNER TO svc_owner;
                 ALTER TABLE org OWNER TO svc_owner; ALTER VIEW person_emails OWNER TO svc_owner;
                 ALTER MATERIALIZED VIEW person_counts OWNER TO svc_owner;
                 CREATE TABLE stray (id int); ALTER TABLE stray OWNER TO svc_owner;`,
            ).code,
        ).toBe(0);
        const r = cliRun(['run', '--db', db, '--scrub', scrubFile, '--allow', allow], { PGOPTIONS: '-c role=rds_master' });
        expect(r.code, r.out).toBe(12);
        expect(relkind(db, 'stray')).toBe('');
        expect(r.out).toContain('revoked svc_owner from rds_master (adopt released)');
        expect(
            psql(db, `SELECT count(*), bool_or(inherit_option), pg_has_role('rds_master', 'rds_iam', 'USAGE')
                        FROM pg_auth_members WHERE roleid = 'svc_owner'::regrole AND member = 'rds_master'::regrole`).out,
        ).toBe('1|f|f');
    });
});
