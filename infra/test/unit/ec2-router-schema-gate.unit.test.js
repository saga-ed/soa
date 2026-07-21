import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Mock everything the restore/switch path touches downstream of the gate —
// this test is only about whether the gate runs, refuses correctly per mode,
// and never fires for non-postgres engines. Real download/seed/compose
// mechanics are covered by profiles-seedfrom.unit.test.js and friends.
vi.mock('../../src/ec2/profiles.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        download_profile_seed: vi.fn(() => '/tmp/fake-seeds'),
        seed_after_start: vi.fn(),
        write_active_profile: vi.fn(),
    };
});

const spawnSync_calls = [];
let sidecarCpResult = { status: 0, stdout: '', stderr: '' };
let revQueryResult = { status: 0, stdout: '20260603120000_add_session_index\n', stderr: '' };

function isSidecarCp(cmd, args) {
    return cmd === 'aws' && args[0] === 's3' && args[1] === 'cp' && args[3] === '-';
}
function isRevQuery(cmd, args) {
    return cmd === 'docker' && args[0] === 'exec' && args.includes('psql')
        && args.some((a) => typeof a === 'string' && a.includes('_prisma_migrations'));
}

vi.mock('child_process', () => ({
    spawnSync: vi.fn((cmd, args) => {
        spawnSync_calls.push([cmd, args]);
        if (isSidecarCp(cmd, args)) return sidecarCpResult;
        if (isRevQuery(cmd, args)) return revQueryResult;
        if (cmd === 'docker' && args[0] === 'compose' && args.includes('ps')) {
            return { status: 0, stdout: 'sbx-db-1\n', stderr: '' };
        }
        if (cmd === 'docker' && args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
            // Container is up in every scenario this file exercises; the
            // running-vs-fresh distinction itself is covered at the
            // check_schema_rev_gate unit level (profiles-schema-gate test).
            return { status: 0, stdout: 'true\n', stderr: '' };
        }
        if (cmd === 'docker' && (args.includes('down') || args.includes('up'))) {
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
}));

import { create_ec2_router } from '../../src/ec2/ec2-router.js';
import { download_profile_seed } from '../../src/ec2/profiles.js';

function setSidecar(schemaRev) {
    sidecarCpResult = { status: 0, stdout: JSON.stringify({ schemaRev }), stderr: '' };
}
function setNoSidecar() {
    sidecarCpResult = { status: 1, stdout: '', stderr: 'NoSuchKey' };
}
function setDbHead(rev) {
    revQueryResult = rev === null
        ? { status: 1, stdout: '', stderr: 'relation "_prisma_migrations" does not exist' }
        : { status: 0, stdout: `${rev}\n`, stderr: '' };
}

function create_test_server(router_options) {
    const app = express();
    app.use('/infra', create_ec2_router(router_options));
    const server = http.createServer(app);
    return new Promise((res) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            res({
                server,
                base_url: `http://127.0.0.1:${port}/infra`,
                close: () => new Promise((r) => server.close(r)),
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

describe('POST /dbs/:name/restore — schemaRev compatibility gate', () => {
    let projects_dir;
    let data_dir;
    let registry_path;
    let test_server;
    const name = 'programs-api-sbx';

    beforeEach(async () => {
        vi.clearAllMocks();
        spawnSync_calls.length = 0;
        setSidecar('20260603120000_add_session_index');
        setDbHead('20260603120000_add_session_index');

        projects_dir = mkdtempSync(join(tmpdir(), 'ec2-router-gate-projects-'));
        data_dir = mkdtempSync(join(tmpdir(), 'ec2-router-gate-data-'));
        registry_path = join(data_dir, 'ports.json');

        mkdirSync(resolve(projects_dir, name), { recursive: true });
        writeFileSync(
            resolve(projects_dir, name, 'docker-compose.yml'),
            'services:\n  db:\n    environment:\n      POSTGRES_DB: "programs"\n      POSTGRES_USER: "postgres_admin"\n',
        );
        writeFileSync(registry_path, JSON.stringify({ [name]: { engine: 'postgres', port: 5440 } }));

        test_server = await create_test_server({ projects_dir, data_dir, registry_path });
    });

    afterEach(async () => {
        await test_server.close();
        rmSync(projects_dir, { recursive: true, force: true });
        rmSync(data_dir, { recursive: true, force: true });
    });

    it('default mode (off): proceeds and never 409s even on an ahead sidecar', async () => {
        setSidecar('20260701000000_later_migration');
        const { status, data } = await api(test_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
        expect(status).toBe(200);
        expect(data.ok).toBe(true);
        expect(download_profile_seed).toHaveBeenCalled();
    });

    it('enforce: 409s with structured body on a missing sidecar, and never calls download_profile_seed', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            setNoSidecar();
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
                expect(status).toBe(409);
                expect(data).toMatchObject({
                    ok: false,
                    verdict: 'no-sidecar',
                    snapshotSchemaRev: null,
                    gateMode: 'enforce',
                });
                expect(data.error).toMatch(/no schema sidecar/);
                expect(download_profile_seed).not.toHaveBeenCalled();
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('enforce: 409s on an ahead sidecar with the rollback-not-supported message', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            setSidecar('20260701000000_later_migration');
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
                expect(status).toBe(409);
                expect(data.verdict).toBe('ahead');
                expect(data.error).toMatch(/rollback not supported/);
                expect(download_profile_seed).not.toHaveBeenCalled();
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('enforce: 409s on a behind sidecar (no auto-heal in v1)', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            setSidecar('20260101000000_old_migration');
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
                expect(status).toBe(409);
                expect(data.verdict).toBe('behind');
                expect(data.error).toMatch(/auto-heal is not enabled/);
                expect(download_profile_seed).not.toHaveBeenCalled();
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('enforce: proceeds on a clean match', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
                expect(status).toBe(200);
                expect(data.ok).toBe(true);
                expect(download_profile_seed).toHaveBeenCalled();
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('enforce: proceeds on a fresh DB with no applied migrations (comparison deferred)', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            setDbHead(null);
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
                expect(status).toBe(200);
                expect(data.ok).toBe(true);
                expect(download_profile_seed).toHaveBeenCalled();
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('warn: logs but proceeds even with no sidecar', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'warn';
        try {
            setNoSidecar();
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/restore`, { profile: 'canonical' });
                expect(status).toBe(200);
                expect(data.ok).toBe(true);
                expect(download_profile_seed).toHaveBeenCalled();
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('/switch shares the same gate as /restore (same choke point)', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            setNoSidecar();
            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path });
            try {
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${name}/switch`, { profile: 'canonical' });
                expect(status).toBe(409);
                expect(data.verdict).toBe('no-sidecar');
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });

    it('mongo/mysql: gate never runs, no rev query, no sidecar fetch, even in enforce', async () => {
        process.env.SNAPSHOT_SCHEMA_GATE = 'enforce';
        try {
            const mongo_name = 'sessions-sbx';
            mkdirSync(resolve(projects_dir, mongo_name), { recursive: true });
            writeFileSync(resolve(projects_dir, mongo_name, 'docker-compose.yml'), 'services:\n  db:\n');
            const mongo_registry_path = join(data_dir, 'mongo-ports.json');
            writeFileSync(mongo_registry_path, JSON.stringify({ [mongo_name]: { engine: 'mongo', port: 27017 } }));

            const gated_server = await create_test_server({ projects_dir, data_dir, registry_path: mongo_registry_path });
            try {
                spawnSync_calls.length = 0;
                const { status, data } = await api(gated_server.base_url, 'POST', `/dbs/${mongo_name}/restore`, { profile: 'canonical' });
                expect(status).toBe(200);
                expect(data.ok).toBe(true);
                expect(spawnSync_calls.some(([cmd, args]) => isSidecarCp(cmd, args))).toBe(false);
                expect(spawnSync_calls.some(([cmd, args]) => isRevQuery(cmd, args))).toBe(false);
            } finally {
                await gated_server.close();
            }
        } finally {
            delete process.env.SNAPSHOT_SCHEMA_GATE;
        }
    });
});
