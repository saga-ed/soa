import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'http';
import express from 'express';

// Mock handlers so the router calls our fakes
vi.mock('../../src/handlers.js', () => ({
    handle_snapshot: vi.fn(),
    handle_switch: vi.fn(),
    handle_reset: vi.fn(),
    handle_restore: vi.fn(),
    handle_list_profiles: vi.fn(),
    handle_delete_profile: vi.fn(),
    handle_get_active: vi.fn(),
}));

import * as handlers from '../../src/handlers.js';
import { create_router } from '../../src/router.js';

// ── Test HTTP helpers ───────────────────────────────────────

/** Start an express app with the infra router and return { server, base_url, close }. */
function create_test_server(router_options = {}) {
    const app = express();
    app.use('/infra', create_router(router_options));
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

/** Simple fetch wrapper that parses JSON. */
async function api(base_url, method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${base_url}${path}`, opts);
    return { status: resp.status, data: await resp.json() };
}

// ── Tests ───────────────────────────────────────────────────

let test_server;

beforeEach(() => {
    vi.clearAllMocks();
});

afterAll(async () => {
    if (test_server) await test_server.close();
});

describe('router routes', () => {
    it('POST /snapshot calls handle_snapshot', async () => {
        handlers.handle_snapshot.mockResolvedValue({ ok: true, profile: 'snap1' });
        test_server = await create_test_server();

        const { status, data } = await api(test_server.base_url, 'POST', '/snapshot', {
            profile: 'snap1', force: true,
        });
        expect(status).toBe(200);
        expect(data.ok).toBe(true);
        expect(handlers.handle_snapshot).toHaveBeenCalledWith(
            expect.objectContaining({ profile: 'snap1', force: true }),
        );
        await test_server.close();
    });

    it('POST /switch calls handle_switch', async () => {
        handlers.handle_switch.mockReturnValue({ ok: true, profile: 'p2' });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'POST', '/switch', { profile: 'p2' });
        expect(data.ok).toBe(true);
        expect(data.profile).toBe('p2');
        await test_server.close();
    });

    it('POST /reset calls handle_reset', async () => {
        handlers.handle_reset.mockReturnValue({ ok: true, profile: 'r1' });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'POST', '/reset', { profile: 'r1' });
        expect(data.ok).toBe(true);
        await test_server.close();
    });

    it('POST /restore calls handle_restore', async () => {
        handlers.handle_restore.mockReturnValue({ ok: true, profile: 's1' });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'POST', '/restore', { profile: 's1' });
        expect(data.ok).toBe(true);
        await test_server.close();
    });

    it('GET /profiles calls handle_list_profiles', async () => {
        handlers.handle_list_profiles.mockReturnValue({
            ok: true, profiles: [{ name: 'p1', type: 'seed', service: 'mongo' }], active: null,
        });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'GET', '/profiles');
        expect(data.ok).toBe(true);
        expect(data.profiles).toHaveLength(1);
        await test_server.close();
    });

    it('POST /delete-profile calls handle_delete_profile', async () => {
        handlers.handle_delete_profile.mockReturnValue({ ok: true, deleted: 2, profile: 'old' });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'POST', '/delete-profile', { profile: 'old' });
        expect(data.ok).toBe(true);
        expect(data.deleted).toBe(2);
        await test_server.close();
    });

    it('GET /active-profile calls handle_get_active', async () => {
        handlers.handle_get_active.mockReturnValue({ ok: true, active: { profile: 'cur', switched_at: '2026-01-01' } });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'GET', '/active-profile');
        expect(data.ok).toBe(true);
        expect(data.active.profile).toBe('cur');
        await test_server.close();
    });

    it('GET /health returns service info', async () => {
        handlers.handle_get_active.mockReturnValue({ ok: true, active: null });
        test_server = await create_test_server();

        const { data } = await api(test_server.base_url, 'GET', '/health');
        expect(data.ok).toBe(true);
        expect(data.service).toBe('infra-compose');
        await test_server.close();
    });
});

describe('router error handling', () => {
    it('returns ok:false from handler errors (non-exception)', async () => {
        handlers.handle_switch.mockReturnValue({ ok: false, error: 'switch failed (exit 1)' });
        test_server = await create_test_server();

        const { status, data } = await api(test_server.base_url, 'POST', '/switch', { profile: 'bad' });
        expect(status).toBe(200); // Handler errors are 200 with ok:false
        expect(data.ok).toBe(false);
        expect(data.error).toContain('switch failed');
        await test_server.close();
    });

    it('returns 500 when handler throws', async () => {
        handlers.handle_snapshot.mockRejectedValue(new Error('unexpected crash'));
        test_server = await create_test_server();

        const { status, data } = await api(test_server.base_url, 'POST', '/snapshot', { profile: 'x' });
        expect(status).toBe(500);
        expect(data.ok).toBe(false);
        expect(data.error).toBe('unexpected crash');
        await test_server.close();
    });
});

describe('router lifecycle hooks', () => {
    it('fires on_after_switch hook on success', async () => {
        const on_after_switch = vi.fn();
        handlers.handle_switch.mockReturnValue({ ok: true, profile: 'hooked' });
        test_server = await create_test_server({ on_after_switch });

        await api(test_server.base_url, 'POST', '/switch', { profile: 'hooked' });
        expect(on_after_switch).toHaveBeenCalledWith({ ok: true, profile: 'hooked' });
        await test_server.close();
    });

    it('does NOT fire on_after_switch hook on failure', async () => {
        const on_after_switch = vi.fn();
        handlers.handle_switch.mockReturnValue({ ok: false, error: 'nope' });
        test_server = await create_test_server({ on_after_switch });

        await api(test_server.base_url, 'POST', '/switch', { profile: 'bad' });
        expect(on_after_switch).not.toHaveBeenCalled();
        await test_server.close();
    });

    it('fires on_after_reset hook on success', async () => {
        const on_after_reset = vi.fn();
        handlers.handle_reset.mockReturnValue({ ok: true, profile: 'reset-hook' });
        test_server = await create_test_server({ on_after_reset });

        await api(test_server.base_url, 'POST', '/reset', { profile: 'reset-hook' });
        expect(on_after_reset).toHaveBeenCalledWith({ ok: true, profile: 'reset-hook' });
        await test_server.close();
    });

    it('fires on_after_snapshot hook on success', async () => {
        const on_after_snapshot = vi.fn();
        handlers.handle_snapshot.mockResolvedValue({ ok: true, profile: 'snap-hook' });
        test_server = await create_test_server({ on_after_snapshot });

        await api(test_server.base_url, 'POST', '/snapshot', { profile: 'snap-hook' });
        expect(on_after_snapshot).toHaveBeenCalledWith(
            expect.objectContaining({ ok: true, profile: 'snap-hook' }),
        );
        await test_server.close();
    });

    it('works with no hooks configured', async () => {
        handlers.handle_switch.mockReturnValue({ ok: true, profile: 'no-hooks' });
        test_server = await create_test_server({}); // no hooks

        const { data } = await api(test_server.base_url, 'POST', '/switch', { profile: 'no-hooks' });
        expect(data.ok).toBe(true); // should not throw
        await test_server.close();
    });
});

describe('router compose_file threading', () => {
    // Covers the fix from commit 5533bcb — compose_file must pass from
    // create_router options through to each handler's input object so a
    // single fixture-serve instance can target a project-specific compose.yml.

    it('threads compose_file from router options into handle_switch input', async () => {
        handlers.handle_switch.mockReturnValue({ ok: true, profile: 'p' });
        test_server = await create_test_server({ compose_file: '/etc/infra/saga-api.yml' });

        await api(test_server.base_url, 'POST', '/switch', { profile: 'p' });
        expect(handlers.handle_switch).toHaveBeenCalledWith(
            expect.objectContaining({ profile: 'p', compose_file: '/etc/infra/saga-api.yml' }),
        );
        await test_server.close();
    });

    it('threads compose_file into handle_reset input', async () => {
        handlers.handle_reset.mockReturnValue({ ok: true, profile: 'r' });
        test_server = await create_test_server({ compose_file: '/etc/infra/saga-api.yml' });

        await api(test_server.base_url, 'POST', '/reset', { profile: 'r' });
        expect(handlers.handle_reset).toHaveBeenCalledWith(
            expect.objectContaining({ profile: 'r', compose_file: '/etc/infra/saga-api.yml' }),
        );
        await test_server.close();
    });

    it('threads compose_file into handle_restore input', async () => {
        handlers.handle_restore.mockReturnValue({ ok: true, profile: 's' });
        test_server = await create_test_server({ compose_file: '/etc/infra/saga-api.yml' });

        await api(test_server.base_url, 'POST', '/restore', { profile: 's' });
        expect(handlers.handle_restore).toHaveBeenCalledWith(
            expect.objectContaining({ profile: 's', compose_file: '/etc/infra/saga-api.yml' }),
        );
        await test_server.close();
    });

    it('handler input compose_file is undefined when router has no compose_file option', async () => {
        handlers.handle_switch.mockReturnValue({ ok: true, profile: 'default-p' });
        test_server = await create_test_server({});

        await api(test_server.base_url, 'POST', '/switch', { profile: 'default-p' });
        const call_args = handlers.handle_switch.mock.calls[0][0];
        expect(call_args.compose_file).toBeUndefined();
        await test_server.close();
    });
});
