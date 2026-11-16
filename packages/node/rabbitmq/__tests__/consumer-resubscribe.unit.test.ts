import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageConsumer } from '../src/consumer.js';
import { MessagePublisher } from '../src/publisher.js';
import { ConnectionManagerClosedError } from '../src/connection-manager.js';

function makeChannel() {
    const ch = new EventEmitter() as EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
    ch.assertQueue = vi.fn().mockResolvedValue({});
    ch.consume = vi.fn().mockResolvedValue({ consumerTag: 'tag' });
    ch.close = vi.fn().mockResolvedValue(undefined);
    return ch;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MessageConsumer resubscribe after channel loss', () => {
    it('re-creates the channel, re-asserts the queue and resubscribes once the connection is back', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const ensureConnected = vi
            .fn()
            .mockRejectedValueOnce(new Error('RabbitMQ reconnecting'))
            .mockResolvedValue(undefined);
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const cm = { ensureConnected, newChannel };
        const consumer = new MessageConsumer(cm as never);
        const handler = vi.fn().mockResolvedValue(true);

        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', handler);
        expect(ch1.consume).toHaveBeenCalledTimes(1);

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000); // first attempt fails (outage)
        expect(ch2.consume).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000); // second attempt succeeds

        expect(ch2.assertQueue).toHaveBeenCalledWith('q');
        expect(ch2.consume).toHaveBeenCalledTimes(1);

        // The resubscribed callback still routes to the original handler.
        const deliver = ch2.consume.mock.calls[0]![1] as (m: unknown) => Promise<void>;
        const msg = { content: Buffer.from('x') };
        Object.assign(ch2, { ack: vi.fn(), nack: vi.fn() });
        await deliver(msg);
        await vi.advanceTimersByTimeAsync(0);
        expect(handler).toHaveBeenCalledWith(msg);
        expect(ch2.ack).toHaveBeenCalledWith(msg);
    });

    it('keeps retrying beyond many failed attempts and stops on stop()', async () => {
        const ch1 = makeChannel();
        const ensureConnected = vi.fn().mockRejectedValue(new Error('down'));
        const cm = { ensureConnected, newChannel: vi.fn().mockResolvedValue(ch1) };
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(ensureConnected.mock.calls.length).toBeGreaterThan(10);

        consumer.stop();
        const calls = ensureConnected.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(ensureConnected.mock.calls.length).toBe(calls);
    });
});

describe('MessageConsumer resubscribe edge cases', () => {
    it('stops retrying once the connection manager is closed', async () => {
        const ch1 = makeChannel();
        const ensureConnected = vi.fn().mockRejectedValue(new ConnectionManagerClosedError());
        const consumer = new MessageConsumer({ ensureConnected, newChannel: vi.fn().mockResolvedValue(ch1) } as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(ensureConnected).toHaveBeenCalledTimes(1);
    });

    it('retries when the new channel closes before setup completes', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const ch3 = makeChannel();
        ch2.consume.mockImplementationOnce(async () => {
            ch2.emit('close');
            return { consumerTag: 't' };
        });
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2).mockResolvedValueOnce(ch3);
        const consumer = new MessageConsumer({ ensureConnected: vi.fn().mockResolvedValue(undefined), newChannel } as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', vi.fn());
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000 + 2_000);
        expect(ch3.consume).toHaveBeenCalledTimes(1);
    });

    it('does not duplicate a subscription registered twice', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const consumer = new MessageConsumer({ ensureConnected: vi.fn().mockResolvedValue(undefined), newChannel } as never);
        const h = vi.fn();
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', h);
        await consumer.consumeFromQueue('c', 'q', h);
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
    });
});

describe('MessagePublisher channel eviction', () => {
    it('drops a closed channel so requestChannel() makes a fresh one', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const publisher = new MessagePublisher({ newChannel } as never);

        await publisher.requestChannel('p');
        ch1.emit('close');
        await publisher.requestChannel('p');

        expect(newChannel).toHaveBeenCalledTimes(2);
    });
});
