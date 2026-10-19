// failFast capability precedence + deprecated NODE_ENV fallback warning.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ConnectionManager,
    resetFailFastFallbackWarning,
} from '../src/connection-manager.js';
import type { RabbitMQConfig } from '../src/connection-manager.js';

vi.mock('amqplib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('amqplib')>();
    return { ...actual, connect: vi.fn() };
});

const { connect: mockConnect } = await import('amqplib');

const NOOP_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeManager(extra: Partial<RabbitMQConfig>) {
    return new ConnectionManager(NOOP_LOGGER as never, {
        url: 'amqp://localhost',
        reconnect: { enabled: true, maxRetries: 1, initialDelay: 1, maxDelay: 1 },
        ...extra,
    });
}

const spyWarn = () => vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

describe('ConnectionManager failFast', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    let warn: ReturnType<typeof spyWarn>;

    beforeEach(() => {
        resetFailFastFallbackWarning();
        warn = spyWarn();
        vi.mocked(mockConnect).mockRejectedValue(new Error('boom'));
    });

    afterEach(() => {
        warn.mockRestore();
        vi.mocked(mockConnect).mockReset();
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    });

    it('failFast=true throws even with NODE_ENV=development', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        await expect(makeManager({ failFast: true }).connect()).rejects.toThrow(
            /circuit breaker opened/,
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it('failFast=false continues even with NODE_ENV=production', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        await expect(makeManager({ failFast: false }).connect()).resolves.toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it('explicit failureMode wins over failFast', async () => {
        await expect(
            makeManager({ failureMode: 'log-and-continue', failFast: true }).connect(),
        ).resolves.toBeUndefined();
        await expect(
            makeManager({ failureMode: 'fatal', failFast: false }).connect(),
        ).rejects.toThrow(/circuit breaker opened/);
    });

    it('without failFast/failureMode follows NODE_ENV and warns exactly once across two calls', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        await expect(makeManager({}).connect()).rejects.toThrow(/circuit breaker opened/);
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        await expect(makeManager({}).connect()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('soa#515'),
            expect.objectContaining({
                type: 'DeprecationWarning',
                code: 'SOA_ENV_FALLBACK_RABBITMQ_FAILFAST',
            }),
        );
    });
});
