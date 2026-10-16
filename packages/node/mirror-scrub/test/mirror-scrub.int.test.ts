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
});
