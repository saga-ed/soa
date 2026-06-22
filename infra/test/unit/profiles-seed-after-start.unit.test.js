import { describe, it, expect, vi, beforeEach } from 'vitest';

// soa#177 — seed_after_start's postgres branch MUST load the dump into the
// configured DB (`psql -d <db_name>`), with ON_ERROR_STOP so a failed load is
// not silently swallowed. A single-DB pg_dump carries no CREATE DATABASE/
// \connect, so a bare `psql -f` (no -d) loads into the role's default DB and the
// configured DB ends up empty while the restore reports success.

const spawnSync_calls = [];

vi.mock('child_process', () => ({
    spawnSync: vi.fn((cmd, args) => {
        spawnSync_calls.push([cmd, args]);
        // Make the health-wait loop exit immediately.
        if (cmd === 'docker' && args[0] === 'inspect') {
            return { status: 0, stdout: 'healthy\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
}));

// The seed file must "exist" so the postgres branch proceeds to load it.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn(() => true),
    };
});

import { seed_after_start } from '../../src/ec2/profiles.js';

/** The args of the `psql ... -f /tmp/01-seed.sql` load invocation (not the rev query). */
function psqlLoadArgs() {
    const call = spawnSync_calls.find(
        ([cmd, args]) =>
            cmd === 'docker' &&
            args[0] === 'exec' &&
            args.includes('psql') &&
            args.includes('/tmp/01-seed.sql'),
    );
    return call ? call[1] : null;
}

describe('seed_after_start — postgres load targets the configured DB (soa#177)', () => {
    beforeEach(() => {
        spawnSync_calls.length = 0;
    });

    it('passes -d <db_name> and ON_ERROR_STOP to the psql load', () => {
        seed_after_start({
            container: 'programs-api-canonical',
            engine: 'postgres',
            seeds_dir: '/tmp/seeds',
            profile: 'canonical',
            db_user: 'postgres_admin',
            db_password: 'pw',
            db_name: 'programs_api_canonical',
        });
        const args = psqlLoadArgs();
        expect(args).not.toBeNull();
        // loads into the configured DB, not the role's default
        const dIdx = args.indexOf('-d');
        expect(dIdx).toBeGreaterThan(-1);
        expect(args[dIdx + 1]).toBe('programs_api_canonical');
        // fails loudly instead of swallowing a bad load
        expect(args).toContain('ON_ERROR_STOP=1');
        // still the right user + file
        expect(args).toContain('postgres_admin');
        expect(args).toContain('/tmp/01-seed.sql');
    });

    it('honors a <profile>@vN pin (db_name still threaded)', () => {
        seed_after_start({
            container: 'programs-api-sbx',
            engine: 'postgres',
            seeds_dir: '/tmp/seeds',
            profile: 'canonical@v2',
            db_user: 'postgres_admin',
            db_password: 'pw',
            db_name: 'programs_api_sbx',
        });
        const args = psqlLoadArgs();
        expect(args).not.toBeNull();
        const dIdx = args.indexOf('-d');
        expect(args[dIdx + 1]).toBe('programs_api_sbx');
    });
});
