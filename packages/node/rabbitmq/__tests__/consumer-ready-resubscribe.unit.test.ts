import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageConsumer } from '../src/consumer.js';
import { ConnectionManager, ConnectionManagerClosedError } from '../src/connection-manager.js';

function makeChannel() {
    const ch = new EventEmitter() as EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
    ch.assertQueue = vi.fn().mockResolvedValue({});
    ch.consume = vi.fn().mockResolvedValue({ consumerTag: 'tag' });
    ch.close = vi.fn().mockResolvedValue(undefined);
    return ch;
}

function makeManager() {
    const listeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    const cm = {
        ensureConnected: vi.fn(),
        newChannel: vi.fn(),
        onReconnected: vi.fn((l: () => void) => {
            listeners.add(l);
            return () => {
                unsubscribe();
                listeners.delete(l);
            };
        }),
    };
    return { cm, fireReconnected: () => [...listeners].forEach((l) => l()), unsubscribe, listeners };
}

vi.mock('amqplib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('amqplib')>();
    return { ...actual, connect: vi.fn() };
});
const { connect: mockConnect } = await import('amqplib');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MessageConsumer resubscribe on reconnect', () => {
    async function lostChannel(cm: ReturnType<typeof makeManager>['cm']) {
        const ch1 = makeChannel();
        cm.newChannel.mockResolvedValueOnce(ch1);
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());
        ch1.emit('close');
        return { consumer, ch1 };
    }

    it('resubscribes immediately on reconnect instead of waiting for the backed-off timer', async () => {
        const { cm, fireReconnected } = makeManager();
        cm.ensureConnected.mockRejectedValue(new Error('RabbitMQ reconnecting'));
        const ch2 = makeChannel();
        const { consumer } = await lostChannel(cm);
        cm.newChannel.mockResolvedValueOnce(ch2);

        await vi.advanceTimersByTimeAsync(40_000); // attempts climb to the 30s cap
        expect(consumer.isConsuming()).toBe(false);
        expect(consumer.state()[0]!.attempts).toBeGreaterThanOrEqual(4);

        cm.ensureConnected.mockResolvedValue(undefined);
        fireReconnected();
        await vi.advanceTimersByTimeAsync(0);

        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(true);
        expect(consumer.state()).toEqual([{ channelName: 'c', status: 'subscribed', attempts: 0 }]);

        await vi.advanceTimersByTimeAsync(60_000); // the cleared timer must not fire again
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
    });

    it('never runs two resubscribes for one channel at once', async () => {
        const { cm, fireReconnected } = makeManager();
        let release!: () => void;
        cm.ensureConnected.mockReturnValue(new Promise<void>((r) => (release = r)));
        const ch2 = makeChannel();
        await lostChannel(cm);
        cm.newChannel.mockResolvedValueOnce(ch2);

        await vi.advanceTimersByTimeAsync(1_000); // timer fires, attempt in flight
        fireReconnected();
        fireReconnected();
        expect(cm.ensureConnected).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
    });

    it('keeps attempts and lastError when a reconnect-triggered resubscribe fails', async () => {
        const { cm, fireReconnected } = makeManager();
        cm.ensureConnected.mockRejectedValue(new Error('RabbitMQ reconnecting'));
        const { consumer } = await lostChannel(cm);
        await vi.advanceTimersByTimeAsync(10_000);
        const before = consumer.state()[0]!.attempts;
        expect(before).toBeGreaterThan(1);

        cm.ensureConnected.mockResolvedValue(undefined);
        cm.newChannel.mockRejectedValueOnce(new Error('406 inequivalent'));
        fireReconnected();
        await vi.advanceTimersByTimeAsync(0);

        expect(consumer.state()[0]).toMatchObject({ status: 'resubscribing', attempts: before + 1, lastError: '406 inequivalent' });
    });

    it('retries at once when a reconnect lands during an attempt that fails with a closed connection', async () => {
        const { cm, fireReconnected } = makeManager();
        let fail!: (e: Error) => void;
        cm.ensureConnected
            .mockReturnValueOnce(new Promise<void>((_, rej) => (fail = rej)))
            .mockResolvedValue(undefined);
        const ch2 = makeChannel();
        const { consumer } = await lostChannel(cm);
        cm.newChannel.mockResolvedValueOnce(ch2);

        await vi.advanceTimersByTimeAsync(1_000);
        fireReconnected();
        fail(new Error('RabbitMQ reconnecting'));
        await vi.advanceTimersByTimeAsync(0);

        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(true);
    });

    it('keeps the backoff when a reconnect lands during an attempt that fails for another reason', async () => {
        const { cm, fireReconnected } = makeManager();
        cm.ensureConnected.mockImplementation(async () => fireReconnected());
        const { consumer } = await lostChannel(cm);
        cm.newChannel.mockRejectedValue(new Error('406 inequivalent'));

        await vi.advanceTimersByTimeAsync(1_000);
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500); // a hot retry would show here
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
        expect(consumer.state()[0]!.attempts).toBe(1);
    });

    it('keeps the backoff when its own ensureConnected() reconnects and the channel then closes', async () => {
        const { cm, fireReconnected } = makeManager();
        cm.ensureConnected.mockImplementation(async () => fireReconnected());
        const { consumer } = await lostChannel(cm);
        cm.newChannel.mockRejectedValue(new Error('Channel closed'));

        await vi.advanceTimersByTimeAsync(1_000);
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
        expect(consumer.state()[0]!.attempts).toBe(1);
    });

    it('a ConnectionManagerClosedError exit clears the in-flight guard', async () => {
        const { cm, fireReconnected } = makeManager();
        cm.ensureConnected.mockRejectedValueOnce(new ConnectionManagerClosedError()).mockResolvedValue(undefined);
        const ch2 = makeChannel();
        const { consumer } = await lostChannel(cm);
        cm.newChannel.mockResolvedValueOnce(ch2);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.consume).not.toHaveBeenCalled();
        fireReconnected();
        await vi.advanceTimersByTimeAsync(0);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(true);
    });

    it('closes the channel of an in-flight resubscribe that completes after stop()', async () => {
        const { cm } = makeManager();
        let release!: () => void;
        cm.ensureConnected.mockReturnValue(new Promise<void>((r) => (release = r)));
        const ch2 = makeChannel();
        const { consumer } = await lostChannel(cm);
        cm.newChannel.mockResolvedValueOnce(ch2);

        await vi.advanceTimersByTimeAsync(1_000);
        consumer.stop();
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(ch2.close).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(false);
    });

    it('ignores reconnects once stopped, and stop() unsubscribes', async () => {
        const { cm, fireReconnected, unsubscribe, listeners } = makeManager();
        cm.ensureConnected.mockResolvedValue(undefined);
        const { consumer } = await lostChannel(cm);

        consumer.stop();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(0);
        fireReconnected();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(cm.newChannel).toHaveBeenCalledTimes(1);
    });

    it('tolerates a connection manager without onReconnected', () => {
        const consumer = new MessageConsumer({ ensureConnected: vi.fn(), newChannel: vi.fn() } as never);
        expect(() => consumer.stop()).not.toThrow();
    });
});

describe('ConnectionManager.onReconnected', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const make = () => new ConnectionManager(logger as never, { url: 'amqp://x', reconnect: { enabled: false } } as never);
    const fakeModel = () => Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });

    it('fires synchronously when a connection is established, once per connect', async () => {
        const cm = make();
        const l = vi.fn();
        cm.onReconnected(l);
        const model = fakeModel();
        vi.mocked(mockConnect).mockResolvedValueOnce(model as never);
        await cm.connect();
        expect(cm.state()).toBe('READY');
        expect(l).toHaveBeenCalledTimes(1);
    });

    it('does not fire on a DEGRADED -> READY unblock', async () => {
        const cm = make();
        const l = vi.fn();
        cm.onReconnected(l);
        const model = fakeModel();
        vi.mocked(mockConnect).mockResolvedValueOnce(model as never);
        await cm.connect();
        model.emit('blocked', 'memory');
        expect(cm.state()).toBe('DEGRADED');
        model.emit('unblocked');
        expect(cm.state()).toBe('READY');
        expect(l).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops delivery; a throwing listener does not break connect or other listeners', async () => {
        const cm = make();
        const bad = vi.fn(() => {
            throw new Error('boom');
        });
        const good = vi.fn();
        const off = cm.onReconnected(bad);
        cm.onReconnected(good);
        vi.mocked(mockConnect).mockResolvedValueOnce(fakeModel() as never);
        await cm.connect();
        expect(cm.state()).toBe('READY');
        expect(good).toHaveBeenCalledTimes(1);
        off();
        expect(bad).toHaveBeenCalledTimes(1);
    });
});
