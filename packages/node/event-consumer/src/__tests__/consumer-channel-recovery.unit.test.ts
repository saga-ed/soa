import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import { EventConsumer } from '../consumer.js';

/**
 * The ConnectionManager auto-reconnects the *connection* after a socket drop,
 * but channels die with the old connection and are not resurrected. For a
 * consumer that failure mode is silent: no errors, no consumption, messages
 * piling up in the durable queue. These tests pin the recovery contract:
 * a non-stop() channel 'close' schedules a re-subscribe (with backoff) that
 * re-runs the full topology setup, while stop() never triggers one.
 */

function makeChannel() {
    const ch = new EventEmitter() as EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
    ch.prefetch = vi.fn().mockResolvedValue(undefined);
    ch.assertExchange = vi.fn().mockResolvedValue({});
    ch.assertQueue = vi.fn().mockResolvedValue({});
    ch.bindQueue = vi.fn().mockResolvedValue({});
    ch.consume = vi.fn().mockResolvedValue({ consumerTag: 'tag-1' });
    ch.cancel = vi.fn().mockResolvedValue(undefined);
    ch.close = vi.fn().mockResolvedValue(undefined);
    ch.ack = vi.fn();
    ch.nack = vi.fn();
    return ch;
}

function makeConsumer(newChannel: ReturnType<typeof vi.fn>) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const connectionManager = {
        ensureConnected: vi.fn().mockResolvedValue(undefined),
        newChannel,
    };
    const consumer = new EventConsumer({
        consumerName: 'test-consumer',
        pool: {} as Pool,
        connectionManager: connectionManager as unknown as ConnectionManager,
        queue: 'test.queue',
        bindings: [{ exchange: 'test.events', routingKey: '#' }],
        handlers: [],
        logger: logger as unknown as ILogger,
    });
    return { consumer, connectionManager, logger };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('EventConsumer channel recovery', () => {
    it("re-subscribes after a channel 'close' it did not initiate", async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { consumer, logger } = makeConsumer(newChannel);

        await consumer.start();
        expect(ch1.consume).toHaveBeenCalledTimes(1);

        ch1.emit('close');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('channel lost'));

        await vi.advanceTimersByTimeAsync(1_000);

        expect(newChannel).toHaveBeenCalledTimes(2);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
        // Full topology re-declared on the new channel.
        expect(ch2.assertExchange).toHaveBeenCalledWith('test.events', 'topic', {
            durable: true,
        });
        expect(ch2.bindQueue).toHaveBeenCalledWith('test.queue', 'test.events', '#');
    });

    it('backs off and keeps retrying while the broker stays down', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi
            .fn()
            .mockResolvedValueOnce(ch1)
            .mockRejectedValueOnce(new Error('still down'))
            .mockRejectedValueOnce(new Error('still down'))
            .mockResolvedValueOnce(ch2);
        const { consumer, logger } = makeConsumer(newChannel);

        await consumer.start();
        ch1.emit('close');

        await vi.advanceTimersByTimeAsync(1_000); // attempt 1 fails
        await vi.advanceTimersByTimeAsync(2_000); // attempt 2 fails (backed off)
        await vi.advanceTimersByTimeAsync(4_000); // attempt 3 succeeds

        expect(newChannel).toHaveBeenCalledTimes(4);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('re-subscribed'));
    });

    it("stop() does not trigger a re-subscribe when the channel then closes", async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch1);
        const { consumer } = makeConsumer(newChannel);

        await consumer.start();
        await consumer.stop();
        // amqplib emits 'close' as the channel finishes closing.
        ch1.emit('close');

        await vi.advanceTimersByTimeAsync(60_000);
        expect(newChannel).toHaveBeenCalledTimes(1);
    });

    it('a pending reconnect is cancelled by stop()', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch1);
        const { consumer } = makeConsumer(newChannel);

        await consumer.start();
        ch1.emit('close'); // schedules reconnect in 1s
        await consumer.stop();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(newChannel).toHaveBeenCalledTimes(1);
    });

    it("does not keep a channel whose 'close' fired during setup", async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        // 'close' arrives before setupChannel's assignment resumes — the
        // close listener's identity guard can't catch it.
        ch1.consume.mockImplementationOnce(async () => {
            ch1.emit('close');
            return { consumerTag: 'tag-1' };
        });
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { consumer } = makeConsumer(newChannel);

        await expect(consumer.start()).rejects.toThrow(/closed during setup/);
        expect(ch1.close).toHaveBeenCalled();

        // start() schedules the backoff loop before rethrowing.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
    });

    it('a stop() racing an in-flight setup closes the channel instead of resuming consumption', async () => {
        const ch1 = makeChannel();
        let releaseChannel!: (ch: unknown) => void;
        const newChannel = vi.fn().mockReturnValue(
            new Promise((res) => {
                releaseChannel = res;
            }),
        );
        const { consumer } = makeConsumer(newChannel);

        const starting = consumer.start();
        await consumer.stop(); // wins the race while setupChannel awaits newChannel
        releaseChannel(ch1);
        await starting;

        await vi.waitFor(() => expect(ch1.close).toHaveBeenCalled());
        expect((consumer as unknown as { channel: unknown }).channel).toBeNull();
    });

    it('schedules the backoff loop when start() itself fails (no silent boot stall)', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const newChannel = vi
            .fn()
            .mockRejectedValueOnce(new Error('boot flake'))
            .mockResolvedValue(ch1);
        const { consumer } = makeConsumer(newChannel);

        await expect(consumer.start()).rejects.toThrow('boot flake');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch1.consume).toHaveBeenCalledTimes(1);
    });

    it('recovers from a broker-initiated consumer cancel (null message)', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { consumer, logger } = makeConsumer(newChannel);

        await consumer.start();
        const onMessage = ch1.consume.mock.calls[0][1] as (msg: unknown) => void;
        onMessage(null); // queue deleted / HA failover: channel stays open

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('cancelled by broker'),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.consume).toHaveBeenCalledTimes(1);
    });

    it('ack/nack on a dead channel is absorbed (broker redelivers; idempotency dedups)', async () => {
        const ch1 = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch1);
        const { consumer, logger } = makeConsumer(newChannel);

        await consumer.start();
        const onMessage = ch1.consume.mock.calls[0][1] as (msg: unknown) => void;

        // Malformed payload → poison → nack path; the channel died in between.
        ch1.nack.mockImplementation(() => {
            throw new Error('IllegalOperationError: Channel closed');
        });
        onMessage({ content: Buffer.from('not json'), fields: {}, properties: {} });
        await vi.waitFor(() => {
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('ack/nack failed on dead channel'),
            );
        });
    });
});
