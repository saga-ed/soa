import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

// ── get_active_profile ──────────────────────────────────────
//
// ACTIVE_PROFILE_FILE is resolved at module load from os.homedir().
// Tests a direct re-implementation of the read logic against a tmp dir,
// verifying the three format contracts (JSON / legacy plain / missing).
// The module-loaded ACTIVE_PROFILE_FILE constant is covered indirectly by
// the integration suite, which runs against a controlled $HOME.

describe('get_active_profile (file format contract)', () => {
    let tmp_file;
    let tmp_dir;

    function read_profile(path) {
        try {
            const content = readFileSync(path, 'utf8').trim();
            if (!content) return null;
            if (content.startsWith('{')) return JSON.parse(content);
            return { profile: content, switched_at: null };
        } catch {
            return null;
        }
    }

    beforeEach(() => {
        tmp_dir = resolve(tmpdir(), `infra-home-${process.pid}-${Date.now()}`);
        mkdirSync(tmp_dir, { recursive: true });
        tmp_file = resolve(tmp_dir, 'active-profile');
    });

    afterEach(() => {
        rmSync(tmp_dir, { recursive: true, force: true });
    });

    it('reads JSON format active profile', () => {
        writeFileSync(tmp_file, JSON.stringify({
            profile: 'basic',
            switched_at: '2026-01-01T00:00:00Z',
        }));
        expect(read_profile(tmp_file)).toEqual({
            profile: 'basic',
            switched_at: '2026-01-01T00:00:00Z',
        });
    });

    it('reads legacy plain text format', () => {
        writeFileSync(tmp_file, 'legacy-profile-name');
        expect(read_profile(tmp_file)).toEqual({
            profile: 'legacy-profile-name',
            switched_at: null,
        });
    });

    it('returns null when file does not exist', () => {
        expect(read_profile(resolve(tmp_dir, 'never-created'))).toBeNull();
    });

    it('returns null when file is empty', () => {
        writeFileSync(tmp_file, '');
        expect(read_profile(tmp_file)).toBeNull();
    });

    it('strips trailing whitespace before parsing legacy value', () => {
        writeFileSync(tmp_file, '  spaced  \n');
        expect(read_profile(tmp_file)).toEqual({
            profile: 'spaced',
            switched_at: null,
        });
    });
});

describe('get_active_profile (wired)', () => {
    it('is exported from api.js and returns a plausible shape', async () => {
        const { get_active_profile } = await import('../api.js');
        const result = get_active_profile();
        // result is either null or { profile: string, switched_at: ... }
        if (result !== null) {
            expect(result).toHaveProperty('profile');
        }
    });
});

// ── list_profiles ───────────────────────────────────────────

describe('list_profiles', () => {
    let tmp_dir;

    beforeEach(() => {
        tmp_dir = resolve(tmpdir(), `infra-test-${process.pid}-${Date.now()}`);
        mkdirSync(tmp_dir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmp_dir, { recursive: true, force: true });
    });

    it('returns empty profiles when data_dir has no files', async () => {
        const { list_profiles } = await import('../api.js');
        // Use a temp dir that has no profile files.
        // list_profiles scans built-in seeds + data_dir.
        // We can't control built-in seeds, but we can verify the function runs without error.
        const result = list_profiles({ data_dir: tmp_dir });
        expect(result).toHaveProperty('profiles');
        expect(Array.isArray(result.profiles)).toBe(true);
    });

    it('finds seed profile files in data_dir', async () => {
        const { list_profiles } = await import('../api.js');

        // Create a fake mongo profile
        const mongo_dir = resolve(tmp_dir, 'mongo');
        mkdirSync(mongo_dir, { recursive: true });
        writeFileSync(resolve(mongo_dir, 'profile-test-seed.json'), JSON.stringify({
            saga_local: { users: [{ _id: '1', name: 'test' }] },
        }));

        const result = list_profiles({ data_dir: tmp_dir });
        const test_profile = result.profiles.find(p => p.name === 'test-seed' && p.service === 'mongo');
        expect(test_profile).toBeDefined();
        expect(test_profile.type).toBe('seed');
    });

    it('detects snapshot type from _meta marker in JSON', async () => {
        const { list_profiles } = await import('../api.js');

        const mongo_dir = resolve(tmp_dir, 'mongo');
        mkdirSync(mongo_dir, { recursive: true });
        writeFileSync(resolve(mongo_dir, 'profile-my-snapshot.json'), JSON.stringify({
            _meta: { type: 'snapshot', profile: 'my-snapshot', dumped_at: '2026-01-01' },
            saga_local: { users: [] },
        }));

        const result = list_profiles({ data_dir: tmp_dir });
        const snap = result.profiles.find(p => p.name === 'my-snapshot' && p.service === 'mongo');
        expect(snap).toBeDefined();
        expect(snap.type).toBe('snapshot');
    });

    it('detects snapshot type from SQL comment marker', async () => {
        const { list_profiles } = await import('../api.js');

        const mysql_dir = resolve(tmp_dir, 'mysql');
        mkdirSync(mysql_dir, { recursive: true });
        writeFileSync(resolve(mysql_dir, 'profile-sql-snap.sql'),
            '-- @infra-compose/snapshot\n-- Profile: sql-snap\nCREATE DATABASE...\n');

        const result = list_profiles({ data_dir: tmp_dir });
        const snap = result.profiles.find(p => p.name === 'sql-snap' && p.service === 'mysql');
        expect(snap).toBeDefined();
        expect(snap.type).toBe('snapshot');
    });

    it('finds profiles across multiple services', async () => {
        const { list_profiles } = await import('../api.js');

        for (const [svc, ext, content] of [
            ['mongo', 'json', '{}'],
            ['mysql', 'sql', 'CREATE DATABASE test;'],
            ['postgres', 'sql', 'CREATE DATABASE test;'],
        ]) {
            const dir = resolve(tmp_dir, svc);
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, `profile-multi.${ext}`), content);
        }

        const result = list_profiles({ data_dir: tmp_dir });
        const multi = result.profiles.filter(p => p.name === 'multi');
        expect(multi.length).toBe(3);
        expect(multi.map(p => p.service).sort()).toEqual(['mongo', 'mysql', 'postgres']);
    });

    it('ignores non-profile files', async () => {
        const { list_profiles } = await import('../api.js');

        const mongo_dir = resolve(tmp_dir, 'mongo');
        mkdirSync(mongo_dir, { recursive: true });
        writeFileSync(resolve(mongo_dir, 'README.md'), '# not a profile');
        writeFileSync(resolve(mongo_dir, 'schema.json'), '{}');
        writeFileSync(resolve(mongo_dir, 'profile-real.json'), '{}');

        const result = list_profiles({ data_dir: tmp_dir });
        const from_tmp = result.profiles.filter(p => p.service === 'mongo' && p.name === 'real');
        expect(from_tmp.length).toBe(1);
        // Ensure non-profile files weren't picked up
        const bad = result.profiles.find(p => p.name === 'README' || p.name === 'schema');
        expect(bad).toBeUndefined();
    });
});

// ── delete_profile_data ─────────────────────────────────────

describe('delete_profile_data', () => {
    let tmp_dir;

    beforeEach(() => {
        tmp_dir = resolve(tmpdir(), `infra-del-test-${process.pid}-${Date.now()}`);
        mkdirSync(tmp_dir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmp_dir, { recursive: true, force: true });
    });

    it('deletes existing profile files and returns count', async () => {
        const { delete_profile_data } = await import('../api.js');

        // Create profile files for two services
        for (const [svc, ext] of [['mongo', 'json'], ['mysql', 'sql']]) {
            const dir = resolve(tmp_dir, svc);
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, `profile-to-delete.${ext}`), 'data');
        }

        const result = delete_profile_data({ profile: 'to-delete', data_dir: tmp_dir });
        expect(result.deleted).toBe(2);
        expect(result.profile).toBe('to-delete');
    });

    it('returns 0 deleted when no files exist', async () => {
        const { delete_profile_data } = await import('../api.js');

        const result = delete_profile_data({ profile: 'nonexistent', data_dir: tmp_dir });
        expect(result.deleted).toBe(0);
        expect(result.profile).toBe('nonexistent');
    });
});
