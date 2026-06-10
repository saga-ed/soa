import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import express from 'express';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock everything that talks to AWS / the host so POST /dbs runs hermetically.
vi.mock('../../src/ec2/volumes.js', () => ({
    create_volume: vi.fn(() => 'vol-test123'),
    attach_and_mount: vi.fn(),
    cleanup_volume: vi.fn(() => true),
    get_instance_metadata: vi.fn(() => ({
        instance_id: 'i-test', az: 'us-west-2a', region: 'us-west-2',
    })),
}));
vi.mock('../../src/ec2/ports.js', () => ({
    allocate_port: vi.fn(() => 5440),
    register_port: vi.fn(),
    release_port: vi.fn(),
    get_allocated_ports: vi.fn(() => ({})),
}));
vi.mock('../../src/ec2/cloudmap.js', () => ({
    register: vi.fn(),
    deregister: vi.fn(),
}));
vi.mock('../../src/ec2/profiles.js', () => ({
    snapshot_db: vi.fn(),
    download_profile_seed: vi.fn(),
    seed_after_start: vi.fn(),
    list_s3_profiles: vi.fn(() => []),
    read_profile_registry: vi.fn(() => ({})),
    write_active_profile: vi.fn(),
}));
// compose_cmd / sync_seeds / hostname shell out via spawnSync; default all to success.
vi.mock('child_process', () => ({
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

import { spawnSync } from 'child_process';
import { create_volume, cleanup_volume } from '../../src/ec2/volumes.js';
import { release_port } from '../../src/ec2/ports.js';
import { create_ec2_router } from '../../src/ec2/ec2-router.js';

function create_test_server(router_options) {
    const app = express();
    app.use('/infra', create_ec2_router(router_options));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                base_url: `http://127.0.0.1:${port}/infra`,
                close: () => new Promise(r => server.close(r)),
            });
        });
    });
}

async function api(base_url, method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${base_url}${path}`, opts);
    return { status: resp.status, data: await resp.json() };
}

describe('POST /dbs provision race + rollback', () => {
    let projects_dir;
    let data_dir;
    let test_server;

    beforeEach(async () => {
        vi.clearAllMocks();
        spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
        projects_dir = mkdtempSync(join(tmpdir(), 'ec2-router-projects-'));
        data_dir = mkdtempSync(join(tmpdir(), 'ec2-router-data-'));
        test_server = await create_test_server({ projects_dir, data_dir, registry_path: join(data_dir, 'ports.json') });
    });

    afterEach(async () => {
        await test_server.close();
        rmSync(projects_dir, { recursive: true, force: true });
        rmSync(data_dir, { recursive: true, force: true });
    });

    it('creates a db and reserves the project dir', async () => {
        const { status, data } = await api(test_server.base_url, 'POST', '/dbs', {
            name: 'svc-pr-1', engine: 'postgres',
        });
        expect(status).toBe(200);
        expect(data).toMatchObject({ ok: true, name: 'svc-pr-1', volumeId: 'vol-test123' });
        expect(existsSync(join(projects_dir, 'svc-pr-1'))).toBe(true);
    });

    it('409s a duplicate provision without touching AWS (name reserved before create)', async () => {
        await api(test_server.base_url, 'POST', '/dbs', { name: 'svc-pr-1', engine: 'postgres' });
        create_volume.mockClear();

        const { status, data } = await api(test_server.base_url, 'POST', '/dbs', {
            name: 'svc-pr-1', engine: 'postgres',
        });
        expect(status).toBe(409);
        expect(data.error).toMatch(/already exists/);
        expect(create_volume).not.toHaveBeenCalled();
    });

    it('rolls back the reservation when volume creation fails, so a retry succeeds', async () => {
        create_volume.mockImplementationOnce(() => { throw new Error('create-volume boom'); });

        const fail = await api(test_server.base_url, 'POST', '/dbs', { name: 'svc-pr-2', engine: 'postgres' });
        expect(fail.status).toBe(500);
        expect(fail.data.error).toMatch(/create-volume boom/);
        expect(existsSync(join(projects_dir, 'svc-pr-2'))).toBe(false);
        expect(release_port).toHaveBeenCalledWith('svc-pr-2', expect.anything());
        // No volume was created, so nothing to clean up
        expect(cleanup_volume).not.toHaveBeenCalled();

        const retry = await api(test_server.base_url, 'POST', '/dbs', { name: 'svc-pr-2', engine: 'postgres' });
        expect(retry.status).toBe(200);
        expect(retry.data.ok).toBe(true);
    });

    it('deletes the created volume when compose up fails', async () => {
        // First spawnSync call in the route is sync_seeds' `aws s3 ls`; the
        // docker compose up is the one with 'compose' in its args.
        spawnSync.mockImplementation((cmd, args) => {
            if (cmd === 'docker' && args.includes('up')) {
                return { status: 1, stdout: '', stderr: 'compose exploded' };
            }
            return { status: 0, stdout: '', stderr: '' };
        });

        const { status, data } = await api(test_server.base_url, 'POST', '/dbs', {
            name: 'svc-pr-3', engine: 'postgres',
        });
        expect(status).toBe(500);
        expect(data.error).toMatch(/compose exploded/);
        expect(cleanup_volume).toHaveBeenCalledWith(expect.objectContaining({ volume_id: 'vol-test123' }));
        expect(release_port).toHaveBeenCalledWith('svc-pr-3', expect.anything());
        expect(existsSync(join(projects_dir, 'svc-pr-3'))).toBe(false);
    });
});
