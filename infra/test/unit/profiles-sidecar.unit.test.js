import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every spawnSync invocation, and let individual tests stub the result of
// the `_prisma_migrations` rev query (a `psql ... -c SELECT migration_name ...`).
const spawnSync_calls = [];
let revQueryResult = { status: 0, stdout: '20260603120000_add_session_index\n', stderr: '' };

function isRevQuery(cmd, args) {
    return (
        cmd === 'docker' &&
        args[0] === 'exec' &&
        args.includes('psql') &&
        args.some((a) => typeof a === 'string' && a.includes('_prisma_migrations'))
    );
}

vi.mock('child_process', () => ({
    spawnSync: vi.fn((cmd, args) => {
        spawnSync_calls.push([cmd, args]);
        if (isRevQuery(cmd, args)) return revQueryResult;
        // `docker compose ps` (container-name lookup) returns a container name.
        if (cmd === 'docker' && args[0] === 'compose' && args.includes('ps')) {
            return { status: 0, stdout: 'sbx-db-1\n', stderr: '' };
        }
        // pg_dump (via run()) returns SQL text.
        if (cmd === 'docker' && args.includes('pg_dump')) {
            return { status: 0, stdout: '-- dump\n', stderr: '' };
        }
        // mongosh export (via run()) must return parseable JSON — snapshot_mongo
        // does JSON.parse on its stdout.
        if (cmd === 'docker' && args.includes('mongosh')) {
            return { status: 0, stdout: '{"_meta":{"type":"snapshot"}}\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
}));

// Stub filesystem writes/reads so we never touch disk. readFileSync must return a
// Buffer-ish with a `.length` (snapshot_db uses it for dumpBytes).
const written = {};
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        writeFileSync: vi.fn((path, content) => {
            written[path] = content;
        }),
        readFileSync: vi.fn(() => Buffer.from('-- dump\n')),
    };
});

import { snapshot_db } from '../../src/ec2/profiles.js';

/** Ordered list of `aws s3 cp` destination args across this snapshot. */
function awsCpDests() {
    return spawnSync_calls
        .filter(([cmd, args]) => cmd === 'aws' && args[0] === 's3' && args[1] === 'cp')
        .map(([, args]) => args[3]);
}

const BASE = {
    name: 'programs-api-sbx',
    profile: 'canonical',
    engine: 'postgres',
    db_name: 'programs',
    db_user: 'postgres_admin',
    bucket: 'seeds-bkt',
    projects_dir: '/opt/projects',
};

describe('snapshot_db — schema sidecar capture', () => {
    beforeEach(() => {
        spawnSync_calls.length = 0;
        for (const k of Object.keys(written)) delete written[k];
        revQueryResult = { status: 0, stdout: '20260603120000_add_session_index\n', stderr: '' };
    });

    it('writes a sidecar next to the dump carrying the extracted schemaRev', () => {
        const result = snapshot_db({ ...BASE });

        expect(result.schemaRev).toBe('20260603120000_add_session_index');
        expect(result.metaPath).toBe('s3://seeds-bkt/programs-api-sbx/profile-canonical.meta.json');
        expect(result.sidecarOk).toBe(true);

        const meta = JSON.parse(written['/tmp/profile-canonical.meta.json']);
        expect(meta).toMatchObject({
            sidecarVersion: 1,
            schemaRev: '20260603120000_add_session_index',
            engine: 'postgres',
            takenFromDb: 'programs-api-sbx',
            profile: 'canonical',
        });
        expect(typeof meta.takenAt).toBe('string');
    });

    it('uploads the .sql BEFORE the sidecar (so a sidecar never points at a missing dump)', () => {
        snapshot_db({ ...BASE });
        const dests = awsCpDests();
        const sqlIdx = dests.indexOf('s3://seeds-bkt/programs-api-sbx/profile-canonical.sql');
        const metaIdx = dests.indexOf('s3://seeds-bkt/programs-api-sbx/profile-canonical.meta.json');
        expect(sqlIdx).toBeGreaterThanOrEqual(0);
        expect(metaIdx).toBeGreaterThanOrEqual(0);
        expect(sqlIdx).toBeLessThan(metaIdx);
    });

    it('records schemaRev=null when _prisma_migrations is absent (non-Prisma DB)', () => {
        // psql exits non-zero: relation "_prisma_migrations" does not exist
        revQueryResult = { status: 1, stdout: '', stderr: 'ERROR: relation does not exist' };
        const result = snapshot_db({ ...BASE });
        expect(result.schemaRev).toBeNull();
        const meta = JSON.parse(written['/tmp/profile-canonical.meta.json']);
        expect(meta.schemaRev).toBeNull();
    });

    it('records schemaRev=null for a fresh DB with zero applied migrations', () => {
        revQueryResult = { status: 0, stdout: '\n', stderr: '' };
        const result = snapshot_db({ ...BASE });
        expect(result.schemaRev).toBeNull();
    });

    it('passes through seedIdsVersion and appGitSha provenance fields', () => {
        snapshot_db({ ...BASE, seed_ids_version: '1.4.0', app_git_sha: 'def4567' });
        const meta = JSON.parse(written['/tmp/profile-canonical.meta.json']);
        expect(meta.seedIdsVersion).toBe('1.4.0');
        expect(meta.appGitSha).toBe('def4567');
    });

    it('writes NO sidecar for mongo (would collide with list_s3_profiles .json pattern)', () => {
        const result = snapshot_db({ ...BASE, engine: 'mongo', profile: 'canonical' });
        // No Prisma rev query, and crucially no sidecar file/upload at all — a mongo
        // `profile-canonical.meta.json` would surface as a phantom `canonical.meta`
        // profile (impl-plan edge-case #6).
        expect(spawnSync_calls.some(([cmd, args]) => isRevQuery(cmd, args))).toBe(false);
        expect(written['/tmp/profile-canonical.meta.json']).toBeUndefined();
        expect(awsCpDests()).not.toContain('s3://seeds-bkt/programs-api-sbx/profile-canonical.meta.json');
        expect(result.metaPath).toBeNull();
        expect(result.schemaRev).toBeNull();
    });

    it('writes NO sidecar for mysql (out of scope; stays byte-for-byte unchanged)', () => {
        const result = snapshot_db({ ...BASE, engine: 'mysql', profile: 'canonical' });
        expect(written['/tmp/profile-canonical.meta.json']).toBeUndefined();
        expect(result.metaPath).toBeNull();
        expect(result.schemaRev).toBeNull();
    });
});
