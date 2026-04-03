import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// Track spawn calls for assertions
const spawn_calls = [];

// Mock child_process.spawn to return controllable child processes
vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

// Mock mongodb and mysql2 — not needed for lifecycle tests but imported by api.js
vi.mock('mongodb', () => ({ default: { MongoClient: vi.fn() } }));
vi.mock('bson', () => ({ EJSON: { stringify: vi.fn() } }));
vi.mock('mysql2/promise', () => ({ default: { createConnection: vi.fn() } }));

import { spawn } from 'child_process';

// ── Helpers ─────────────────────────────────────────────────

/** Create a mock child process that emits 'close' with the given result. */
function make_mock_child(result) {
    const child = new EventEmitter();
    // If stdio is piped, create readable streams
    if (result.stdout !== undefined) {
        const stdout_stream = new EventEmitter();
        child.stdout = stdout_stream;
    }
    if (result.stderr !== undefined) {
        const stderr_stream = new EventEmitter();
        child.stderr = stderr_stream;
    }
    child.kill = vi.fn();
    // Emit data and close asynchronously (next tick) to simulate real spawn
    process.nextTick(() => {
        if (child.stdout && result.stdout) child.stdout.emit('data', result.stdout);
        if (child.stderr && result.stderr) child.stderr.emit('data', result.stderr);
        child.emit('close', result.status ?? 0, result.signal || null);
    });
    return child;
}

/** Configure spawn mock to return specific results per call index. */
function mock_spawn_sequence(results) {
    let call_idx = 0;
    spawn_calls.length = 0;
    spawn.mockImplementation((cmd, args, options) => {
        spawn_calls.push([cmd, args, options]);
        const result = results[call_idx] || { status: 0 };
        call_idx++;
        return make_mock_child(result);
    });
}

/** Configure spawn mock to return success for all calls. */
function mock_spawn_success() {
    mock_spawn_sequence([]);
}

/** Extract the docker commands from spawn calls. */
function get_docker_calls() {
    return spawn_calls
        .filter(([cmd]) => cmd === 'docker' || cmd === 'docker-compose')
        .map(([cmd, args]) => cmd === 'docker' ? args.join(' ') : `docker-compose ${args.join(' ')}`);
}

// ── switch_profile ──────────────────────────────────────────

describe('switch_profile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        spawn_calls.length = 0;
    });

    it('calls docker compose down then up with SEED_PROFILE env', async () => {
        mock_spawn_success();
        const { switch_profile } = await import('../api.js');

        const result = await switch_profile({ profile: 'my-profile' });
        expect(result.status).toBe(0);
        expect(result.profile).toBe('my-profile');

        const calls = get_docker_calls();
        expect(calls[0]).toBe('compose down');
        expect(calls[1]).toBe('compose up -d');

        // Verify SEED_PROFILE was set in env
        const up_call = spawn_calls.find(([cmd, args]) =>
            cmd === 'docker' && args.includes('up'));
        expect(up_call[2].env.SEED_PROFILE).toBe('my-profile');
    });

    it('returns failure status when down fails', async () => {
        mock_spawn_sequence([
            { status: 1, stdout: '', stderr: 'down failed' }, // down fails
        ]);
        const { switch_profile } = await import('../api.js');

        const result = await switch_profile({ profile: 'bad' });
        expect(result.status).toBe(1);

        // Should not attempt up after failed down
        const calls = get_docker_calls();
        expect(calls.length).toBe(1);
        expect(calls[0]).toBe('compose down');
    });

    it('returns failure status when up fails', async () => {
        mock_spawn_sequence([
            { status: 0 }, // down succeeds
            { status: 1 }, // up fails
        ]);
        const { switch_profile } = await import('../api.js');

        const result = await switch_profile({ profile: 'bad-up' });
        expect(result.status).toBe(1);
    });
});

// ── reset ───────────────────────────────────────────────────

describe('reset', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        spawn_calls.length = 0;
    });

    it('calls down, lists volumes, removes them, then up', async () => {
        mock_spawn_sequence([
            { status: 0 },  // docker compose down
            { status: 0, stdout: 'infra-mongo-profile-test\ninfra-mysql-profile-test\n' }, // volume ls
            { status: 0 },  // volume rm (batch)
            { status: 0 },  // docker compose up
        ]);
        const { reset } = await import('../api.js');

        const result = await reset({ profile: 'test' });
        expect(result.status).toBe(0);
        expect(result.profile).toBe('test');

        const calls = get_docker_calls();
        expect(calls[0]).toBe('compose down');
        expect(calls[1]).toContain('volume ls --filter name=-profile-test');
        expect(calls[2]).toBe('volume rm infra-mongo-profile-test infra-mysql-profile-test');
        expect(calls[3]).toBe('compose up -d');
    });

    it('skips volume removal when no volumes exist', async () => {
        mock_spawn_sequence([
            { status: 0 },           // down
            { status: 0, stdout: '' }, // volume ls (empty)
            { status: 0 },           // up (no volume rm step)
        ]);
        const { reset } = await import('../api.js');

        const result = await reset({ profile: 'fresh' });
        expect(result.status).toBe(0);

        const calls = get_docker_calls();
        // Should be: down, volume ls, up (no volume rm)
        expect(calls).not.toContainEqual(expect.stringContaining('volume rm'));
    });

    it('stops on down failure', async () => {
        mock_spawn_sequence([
            { status: 1 }, // down fails
        ]);
        const { reset } = await import('../api.js');

        const result = await reset({ profile: 'fail' });
        expect(result.status).toBe(1);
        expect(get_docker_calls().length).toBe(1);
    });

    it('stops on volume rm failure', async () => {
        mock_spawn_sequence([
            { status: 0 },                                     // down
            { status: 0, stdout: 'vol-profile-x\n' },          // volume ls
            { status: 1 },                                     // volume rm fails
        ]);
        const { reset } = await import('../api.js');

        const result = await reset({ profile: 'x' });
        expect(result.status).toBe(1);
        // Should not attempt up
        const calls = get_docker_calls();
        expect(calls).not.toContainEqual(expect.stringContaining('compose up'));
    });
});

// ── restore ─────────────────────────────────────────────────

describe('restore', () => {
    let tmp_dir;

    beforeEach(() => {
        vi.clearAllMocks();
        spawn_calls.length = 0;
        tmp_dir = resolve(tmpdir(), `infra-restore-test-${process.pid}-${Date.now()}`);
        mkdirSync(tmp_dir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmp_dir, { recursive: true, force: true });
    });

    it('returns error when no seed files exist', async () => {
        const { restore } = await import('../api.js');

        const result = await restore({ profile: 'nonexistent', data_dir: tmp_dir });
        expect(result.status).toBe(1);
        // No docker calls should be made
        expect(get_docker_calls().length).toBe(0);
    });

    it('calls reset when volumes exist for profile', async () => {
        const { restore } = await import('../api.js');

        // Create a seed file so the profile is found
        const mongo_dir = resolve(tmp_dir, 'mongo');
        mkdirSync(mongo_dir, { recursive: true });
        writeFileSync(resolve(mongo_dir, 'profile-has-vols.json'), '{}');

        mock_spawn_sequence([
            { status: 0, stdout: 'vol-profile-has-vols\n' }, // volume ls (volumes exist)
            { status: 0 },                                    // docker compose down (reset)
            { status: 0, stdout: 'vol-profile-has-vols\n' }, // volume ls (reset's own check)
            { status: 0 },                                    // volume rm
            { status: 0 },                                    // docker compose up
        ]);

        const result = await restore({ profile: 'has-vols', data_dir: tmp_dir });
        expect(result.status).toBe(0);

        const calls = get_docker_calls();
        // Should see: volume ls (restore check), down, volume ls (reset), volume rm, up
        expect(calls.some(c => c.includes('compose down'))).toBe(true);
        expect(calls.some(c => c.includes('compose up'))).toBe(true);
    });

    it('calls up directly when no volumes exist', async () => {
        const { restore } = await import('../api.js');

        const mysql_dir = resolve(tmp_dir, 'mysql');
        mkdirSync(mysql_dir, { recursive: true });
        writeFileSync(resolve(mysql_dir, 'profile-fresh.sql'), 'CREATE DATABASE test;');

        mock_spawn_sequence([
            { status: 0, stdout: '' },  // volume ls (no volumes)
            { status: 0 },             // docker compose up
        ]);

        const result = await restore({ profile: 'fresh', data_dir: tmp_dir });
        expect(result.status).toBe(0);

        const calls = get_docker_calls();
        // Should NOT see a down call (no reset needed)
        expect(calls.some(c => c.includes('compose down'))).toBe(false);
        expect(calls.some(c => c.includes('compose up'))).toBe(true);
    });
});
