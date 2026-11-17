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
        createConfirmChannel: vi.fn().mockResolvedValue(channel),
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

describe.each([
    ['newChannel', (cm: ConnectionManager) => cm.newChannel()],
    ['newConfirmChannel', (cm: ConnectionManager) => cm.newConfirmChannel()],
])('ConnectionManager.%s error handling', (_name, open) => {
    it('does not throw when the channel emits error, and logs at error', async () => {
        const ch = Object.assign(new EventEmitter(), { ch: 7 });
        const cm = await connectedManager(ch);
        const out = await open(cm);
        expect(out).toBe(ch);
        expect(() => ch.emit('error', new Error('PRECONDITION_FAILED - inequivalent arg'))).not.toThrow();
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/ 7 error: .*PRECONDITION_FAILED/));
    });

    it('does not double-log when the caller has its own error listener, and still fires it', async () => {
        const ch = new EventEmitter();
        const cm = await connectedManager(ch);
        const out = await open(cm);
        const mine = vi.fn();
        out.on('error', mine);
        ch.emit('error', new Error('boom'));
        expect(mine).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
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

describe('ConnectionManager.assertQueues', () => {
    it('closes the channel and tolerates it already being closed after a refused declare', async () => {
        const ch = Object.assign(new EventEmitter(), {
            assertQueue: vi.fn().mockRejectedValue(new Error('PRECONDITION_FAILED')),
            close: vi.fn().mockRejectedValue(new Error('Channel closed')),
        });
        const cm = await connectedManager(ch);
        await expect(cm.assertQueues([{ name: 'q' } as never])).rejects.toThrow('PRECONDITION_FAILED');
        expect(ch.close).toHaveBeenCalledTimes(1);
    });
});
