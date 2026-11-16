import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../src/connection-manager.js';

vi.mock('amqplib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('amqplib')>();
    return { ...actual, connect: vi.fn() };
});

const { connect: mockConnect } = await import('amqplib');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => vi.clearAllMocks());

async function connectedManager(channel: EventEmitter) {
    const model = Object.assign(new EventEmitter(), {
        close: vi.fn().mockResolvedValue(undefined),
        createChannel: vi.fn().mockResolvedValue(channel),
    });
    (mockConnect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    const cm = new ConnectionManager(logger as never, {
        url: 'amqp://localhost',
        failureMode: 'log-and-continue',
        reconnect: { enabled: false, maxRetries: 0, initialDelay: 1000, maxDelay: 1000 },
    });
    await cm.connect();
    return cm;
}

describe('ConnectionManager.newChannel error handling', () => {
    it('does not throw when the channel emits error, and logs at warn', async () => {
        const ch = new EventEmitter();
        const cm = await connectedManager(ch);
        const out = await cm.newChannel();
        expect(out).toBe(ch);
        expect(() => ch.emit('error', new Error('PRECONDITION_FAILED - inequivalent arg'))).not.toThrow();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('PRECONDITION_FAILED'));
    });

    it('still delivers close to caller listeners', async () => {
        const ch = new EventEmitter();
        const cm = await connectedManager(ch);
        const out = await cm.newChannel();
        const onClose = vi.fn();
        out.on('close', onClose);
        ch.emit('close');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
