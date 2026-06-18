import { describe, it, expect, vi, beforeEach } from 'vitest';

// soa#168 — numbered immutable snapshot versions. Mirrors the mocking style of
// profiles-sidecar.unit.test.js: capture spawnSync, stub `aws s3 ls` (the
// version-enumeration call) and the prisma-rev query, stub fs writes.

const spawnSync_calls = [];
// `aws s3 ls <prefix>` output the version helpers parse — set per test.
let s3LsStdout = '';
let revQueryResult = { status: 0, stdout: '20260603120000_add_session_index\n', stderr: '' };

function isRevQuery(cmd, args) {
    return cmd === 'docker' && args[0] === 'exec' && args.includes('psql') &&
        args.some((a) => typeof a === 'string' && a.includes('_prisma_migrations'));
}

vi.mock('child_process', () => ({
    spawnSync: vi.fn((cmd, args) => {
        spawnSync_calls.push([cmd, args]);
        if (cmd === 'aws' && args[0] === 's3' && args[1] === 'ls') {
            return { status: s3LsStdout ? 0 : 1, stdout: s3LsStdout, stderr: '' };
        }
        if (isRevQuery(cmd, args)) return revQueryResult;
        if (cmd === 'docker' && args[0] === 'compose' && args.includes('ps')) {
            return { status: 0, stdout: 'sbx-db-1\n', stderr: '' };
        }
        if (cmd === 'docker' && args.includes('pg_dump')) {
            return { status: 0, stdout: '-- dump\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
}));

const written = {};
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        writeFileSync: vi.fn((path, content) => { written[path] = content; }),
        readFileSync: vi.fn(() => Buffer.from('-- dump\n')),
    };
});

const { snapshot_db, next_profile_version, list_profile_versions } = await import('../../src/ec2/profiles.js');

/** Ordered `aws s3 cp` destinations. */
function cpDests() {
    return spawnSync_calls
        .filter(([cmd, args]) => cmd === 'aws' && args[0] === 's3' && args[1] === 'cp')
        .map(([, args]) => args[3]);
}
/** A given `aws s3 cp` source→dest pair exists. */
function cpPair(src, dest) {
    return spawnSync_calls.some(([cmd, args]) =>
        cmd === 'aws' && args[0] === 's3' && args[1] === 'cp' && args[2] === src && args[3] === dest);
}

// Helper: render an `aws s3 ls` listing line for a file.
const lsLine = (file, size = 100) => `2026-06-18 00:00:00  ${size} ${file}`;

const BASE = {
    name: 'programs-api-canonical',
    profile: 'canonical',
    engine: 'postgres',
    db_name: 'programs',
    db_user: 'postgres_admin',
    bucket: 'seeds-bkt',
    projects_dir: '/opt/projects',
};

beforeEach(() => {
    spawnSync_calls.length = 0;
    for (const k of Object.keys(written)) delete written[k];
    s3LsStdout = '';
    revQueryResult = { status: 0, stdout: '20260603120000_add_session_index\n', stderr: '' };
});

describe('next_profile_version / list_profile_versions', () => {
    it('returns v1 when no versions exist yet', () => {
        s3LsStdout = '';
        expect(next_profile_version({ ...BASE })).toBe(1);
        expect(list_profile_versions({ ...BASE })).toEqual([]);
    });

    it('increments past the max existing version (ignores the pointer + sidecars)', () => {
        s3LsStdout = [
            lsLine('profile-canonical.sql'),            // the mutable pointer — ignored
            lsLine('profile-canonical.meta.json'),      // pointer sidecar — ignored
            lsLine('profile-canonical-v1.sql'),
            lsLine('profile-canonical-v1.meta.json'),   // versioned sidecar — ignored (not .sql)
            lsLine('profile-canonical-v2.sql'),
        ].join('\n');
        expect(list_profile_versions({ ...BASE })).toEqual([1, 2]);
        expect(next_profile_version({ ...BASE })).toBe(3);
    });

    it('does not confuse a different profile\'s versions', () => {
        s3LsStdout = [
            lsLine('profile-canonical-v5.sql'),
            lsLine('profile-other-v9.sql'),             // different profile — must not count
        ].join('\n');
        expect(list_profile_versions({ ...BASE, profile: 'canonical' })).toEqual([5]);
        expect(next_profile_version({ ...BASE, profile: 'canonical' })).toBe(6);
    });
});

describe('snapshot_db — numbered immutable versions', () => {
    it('first snapshot writes v1 + advances the latest-pointer', () => {
        s3LsStdout = ''; // no existing versions
        const result = snapshot_db({ ...BASE });

        expect(result.version).toBe(1);
        expect(result.versionedS3Path).toBe('s3://seeds-bkt/programs-api-canonical/profile-canonical-v1.sql');
        expect(result.s3Path).toBe('s3://seeds-bkt/programs-api-canonical/profile-canonical.sql');

        // immutable dump uploaded, then pointer copied FROM it (server-side copy)
        expect(cpDests()).toContain('s3://seeds-bkt/programs-api-canonical/profile-canonical-v1.sql');
        expect(cpPair(
            's3://seeds-bkt/programs-api-canonical/profile-canonical-v1.sql',
            's3://seeds-bkt/programs-api-canonical/profile-canonical.sql',
        )).toBe(true);

        // sidecar carries the version + supersedes provenance
        const meta = JSON.parse(written['/tmp/profile-canonical.meta.json']);
        expect(meta.version).toBe(1);
        expect(meta.supersedes).toBeNull();
    });

    it('re-cut writes the NEXT version and never overwrites a prior one', () => {
        s3LsStdout = [lsLine('profile-canonical-v1.sql'), lsLine('profile-canonical.sql')].join('\n');
        const result = snapshot_db({ ...BASE });

        expect(result.version).toBe(2);
        const dests = cpDests();
        // the new immutable artifact is v2 …
        expect(dests).toContain('s3://seeds-bkt/programs-api-canonical/profile-canonical-v2.sql');
        // … and NOTHING is uploaded to v1 (prior version untouched)
        expect(dests).not.toContain('s3://seeds-bkt/programs-api-canonical/profile-canonical-v1.sql');

        const meta = JSON.parse(written['/tmp/profile-canonical.meta.json']);
        expect(meta.version).toBe(2);
        expect(meta.supersedes).toBe(1);
    });

    it('uploads the versioned dump + versioned sidecar BEFORE advancing either pointer', () => {
        s3LsStdout = '';
        snapshot_db({ ...BASE });
        const dests = cpDests();
        const vSql = dests.indexOf('s3://seeds-bkt/programs-api-canonical/profile-canonical-v1.sql');
        const vMeta = dests.indexOf('s3://seeds-bkt/programs-api-canonical/profile-canonical-v1.meta.json');
        const pSql = dests.indexOf('s3://seeds-bkt/programs-api-canonical/profile-canonical.sql');
        const pMeta = dests.indexOf('s3://seeds-bkt/programs-api-canonical/profile-canonical.meta.json');
        // versioned artifacts come first; pointers (copies) come after their source
        expect(vSql).toBeGreaterThanOrEqual(0);
        expect(vSql).toBeLessThan(pSql);
        expect(vMeta).toBeGreaterThanOrEqual(0);
        expect(vMeta).toBeLessThan(pMeta);
    });
});
