import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageConsumer } from '../src/consumer.js';
import { ConnectionManager } from '../src/connection-manager.js';

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
        onReady: vi.fn((l: () => void) => {
            listeners.add(l);
            return () => {
                unsubscribe();
                listeners.delete(l);
            };
        }),
    };
    return { cm, fireReady: () => [...listeners].forEach((l) => l()), unsubscribe, listeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MessageConsumer resubscribe on READY', () => {
    it('resubscribes immediately on READY instead of waiting for the backed-off timer', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { cm, fireReady } = makeManager();
        cm.ensureConnected.mockRejectedValue(new Error('RabbitMQ reconnecting'));
        cm.newChannel.mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(40_000); // attempts climb to the 30s cap
        expect(consumer.isConsuming()).toBe(false);
        expect(consumer.state()[0]!.attempts).toBeGreaterThanOrEqual(4);

        cm.ensureConnected.mockResolvedValue(undefined);
        fireReady();
        await vi.advanceTimersByTimeAsync(0);

        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(true);
        expect(consumer.state()).toEqual([{ channelName: 'c', status: 'subscribed', attempts: 0 }]);

        // The cleared timer must not fire a second resubscribe later.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
    });

    it('never runs two resubscribes for one channel at once', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { cm, fireReady } = makeManager();
        let release!: () => void;
        cm.ensureConnected.mockReturnValue(new Promise<void>((r) => (release = r)));
        cm.newChannel.mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000); // timer fires, attempt is in flight
        fireReady();
        fireReady();
        expect(cm.ensureConnected).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
    });

    it('retries at once when READY lands while an attempt that began before it fails', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { cm, fireReady } = makeManager();
        let fail!: (e: Error) => void;
        cm.ensureConnected
            .mockReturnValueOnce(new Promise<void>((_, rej) => (fail = rej)))
            .mockResolvedValue(undefined);
        cm.newChannel.mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        fireReady();
        fail(new Error('RabbitMQ reconnecting'));
        await vi.advanceTimersByTimeAsync(0);

        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(true);
    });

    it('keeps the backoff when the READY came from this attempt\'s own ensureConnected()', async () => {
        const ch1 = makeChannel();
        const { cm, fireReady } = makeManager();
        cm.ensureConnected.mockImplementation(async () => {
            fireReady(); // READY lands as ensureConnected resolves
        });
        cm.newChannel.mockResolvedValueOnce(ch1).mockRejectedValue(new Error('channel boom'));
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(500); // would be a hot retry without the guard
        expect(cm.newChannel).toHaveBeenCalledTimes(2);
        expect(consumer.state()[0]!.attempts).toBe(1);
    });

    it('closes the channel of an in-flight resubscribe that completes after stop()', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { cm } = makeManager();
        let release!: () => void;
        cm.ensureConnected.mockReturnValue(new Promise<void>((r) => (release = r)));
        cm.newChannel.mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        consumer.stop();
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(ch2.close).toHaveBeenCalledTimes(1);
        expect(consumer.isConsuming()).toBe(false);
    });

    it('tolerates a connection manager without onReady', () => {
        const consumer = new MessageConsumer({ ensureConnected: vi.fn(), newChannel: vi.fn() } as never);
        expect(() => consumer.stop()).not.toThrow();
    });

    it('ignores READY once stopped, and stop() unsubscribes', async () => {
        const ch1 = makeChannel();
        const { cm, fireReady, unsubscribe, listeners } = makeManager();
        cm.ensureConnected.mockResolvedValue(undefined);
        cm.newChannel.mockResolvedValue(ch1);
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());
        ch1.emit('close');

        consumer.stop();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(0);
        fireReady();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(cm.newChannel).toHaveBeenCalledTimes(1);
    });
});

describe('ConnectionManager.onReady', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const make = () => new ConnectionManager(logger as never, { url: 'amqp://x' } as never);
    const setState = (cm: ConnectionManager, s: string) => (cm as never as { setState(s: string): void }).setState(s);

    const flush = () => Promise.resolve();

    it('fires on each transition into READY, not on other states or repeats', async () => {
        const cm = make();
        const l = vi.fn();
        cm.onReady(l);
        setState(cm, 'CONNECTING');
        expect(l).not.toHaveBeenCalled();
        setState(cm, 'READY');
        setState(cm, 'READY');
        await flush();
        expect(l).toHaveBeenCalledTimes(1);
        setState(cm, 'RECONNECTING');
        setState(cm, 'READY');
        await flush();
        expect(l).toHaveBeenCalledTimes(2);
    });

    it('does not fire on DEGRADED -> READY (flow-control unblock)', async () => {
        const cm = make();
        const l = vi.fn();
        cm.onReady(l);
        setState(cm, 'READY');
        await flush();
        setState(cm, 'DEGRADED');
        setState(cm, 'READY');
        await flush();
        expect(l).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe stops delivery; a throwing listener does not break setState or other listeners', async () => {
        const cm = make();
        const bad = vi.fn(() => {
            throw new Error('boom');
        });
        const good = vi.fn();
        const off = cm.onReady(bad);
        cm.onReady(good);
        setState(cm, 'READY');
        expect(cm.state()).toBe('READY');
        await flush();
        expect(good).toHaveBeenCalledTimes(1);
        off();
        setState(cm, 'RECONNECTING');
        setState(cm, 'READY');
        await flush();
        expect(bad).toHaveBeenCalledTimes(1);
        expect(good).toHaveBeenCalledTimes(2);
    });
});
