import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ILogger } from '@saga-ed/soa-logger';

vi.mock('child_process', () => ({
    spawnSync: vi.fn(),
}));

import { spawnSync } from 'child_process';
import { create_service_restarter } from '../utils/service-restart.js';

function make_logger(): ILogger & { calls: { level: string; msg: string }[] } {
    const calls: { level: string; msg: string }[] = [];
    const push = (level: string) => (msg: string) => { calls.push({ level, msg }); };
    return {
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
        debug: push('debug'),
        trace: push('trace'),
        fatal: push('fatal'),
        calls,
    } as unknown as ILogger & { calls: { level: string; msg: string }[] };
}

describe('create_service_restarter', () => {
    const spawn_mock = spawnSync as unknown as ReturnType<typeof vi.fn>;
    let fetch_spy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        spawn_mock.mockReset();
        fetch_spy = vi.fn();
        vi.stubGlobal('fetch', fetch_spy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('skips cleanly when no matching units are running', async () => {
        spawn_mock.mockReturnValueOnce({ stdout: '', stderr: '', status: 0 });

        const restart = create_service_restarter('saga_api-*', 'http://localhost:3000/health', { timeout_ms: 100, poll_interval_ms: 50 });
        const logger = make_logger();
        await restart(logger);

        expect(spawn_mock).toHaveBeenCalledTimes(1);
        const discovery_call = spawn_mock.mock.calls[0];
        expect(discovery_call[1][1]).toContain('systemctl list-units "saga_api-*.service"');
        expect(logger.calls.find(c => c.level === 'info' && c.msg.includes('no running'))).toBeDefined();
    });

    it('restarts discovered units and returns once health endpoint is 200', async () => {
        spawn_mock
            .mockReturnValueOnce({ stdout: 'saga_api-iam.service\nsaga_api-pgm.service\n', stderr: '', status: 0 })
            .mockReturnValueOnce({ stdout: '', stderr: '', status: 0 });
        fetch_spy.mockResolvedValueOnce({ ok: true });

        const restart = create_service_restarter('saga_api-*', 'http://localhost:3000/health', { timeout_ms: 200, poll_interval_ms: 20 });
        const logger = make_logger();
        await restart(logger);

        const restart_call = spawn_mock.mock.calls[1];
        expect(restart_call[0]).toBe('sudo');
        expect(restart_call[1]).toEqual(['systemctl', 'restart', 'saga_api-iam.service', 'saga_api-pgm.service']);
        expect(logger.calls.find(c => c.level === 'info' && c.msg.includes('is healthy'))).toBeDefined();
    });

    it('warns when systemctl restart fails and does not poll health', async () => {
        spawn_mock
            .mockReturnValueOnce({ stdout: 'saga_api-iam.service\n', stderr: '', status: 0 })
            .mockReturnValueOnce({ stdout: '', stderr: 'access denied', status: 1 });

        const restart = create_service_restarter('saga_api-*', 'http://localhost:3000/health', { timeout_ms: 100, poll_interval_ms: 20 });
        const logger = make_logger();
        await restart(logger);

        expect(fetch_spy).not.toHaveBeenCalled();
        expect(logger.calls.find(c => c.level === 'warn' && c.msg.includes('systemctl restart failed'))).toBeDefined();
    });

    it('warns when health check never succeeds within timeout', async () => {
        spawn_mock
            .mockReturnValueOnce({ stdout: 'saga_api-iam.service\n', stderr: '', status: 0 })
            .mockReturnValueOnce({ stdout: '', stderr: '', status: 0 });
        fetch_spy.mockRejectedValue(new Error('connection refused'));

        const restart = create_service_restarter('saga_api-*', 'http://localhost:3000/health', { timeout_ms: 80, poll_interval_ms: 20 });
        const logger = make_logger();
        await restart(logger);

        expect(fetch_spy).toHaveBeenCalled();
        expect(logger.calls.find(c => c.level === 'warn' && c.msg.includes('did not become healthy'))).toBeDefined();
    });

    it('tolerates unexpected errors and logs them as warnings', async () => {
        spawn_mock.mockImplementation(() => { throw new Error('spawn blew up'); });

        const restart = create_service_restarter('saga_api-*', 'http://localhost:3000/health', { timeout_ms: 50, poll_interval_ms: 10 });
        const logger = make_logger();
        await expect(restart(logger)).resolves.toBeUndefined();
        expect(logger.calls.find(c => c.level === 'warn' && c.msg.includes('spawn blew up'))).toBeDefined();
    });
});
