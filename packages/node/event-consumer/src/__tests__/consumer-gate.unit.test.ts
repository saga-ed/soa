import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ConsumeMessage } from 'amqplib';
import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import { EventConsumer, type ActivityGate } from '../consumer.js';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function makeGate(initial: boolean) {
    const emitter = new EventEmitter();
    let active = initial;
    const gate: ActivityGate = {
        isActive: () => active,
        on: (_event, cb) => emitter.on('change', cb),
    };
    return {
        gate,
        set(next: boolean) {
            active = next;
            emitter.emit('change', next, next ? 'blue' : 'green');
        },
    };
}

type Delivery = (msg: ConsumeMessage | null) => void;

function makeChannel() {
    const ch = new EventEmitter() as EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
    const deliveries: Delivery[] = [];
    let n = 0;
    ch.prefetch = vi.fn().mockResolvedValue(undefined);
    ch.assertExchange = vi.fn().mockResolvedValue({});
    ch.assertQueue = vi.fn().mockResolvedValue({});
    ch.bindQueue = vi.fn().mockResolvedValue({});
    ch.consume = vi.fn().mockImplementation(async (_q: string, cb: Delivery) => {
        deliveries.push(cb);
        return { consumerTag: `tag-${++n}` };
    });
    ch.cancel = vi.fn().mockResolvedValue(undefined);
    ch.close = vi.fn().mockResolvedValue(undefined);
    ch.ack = vi.fn();
    ch.nack = vi.fn();
    return Object.assign(ch, { deliveries });
}

// Pool whose handler body blocks until released, so dispatch stays in flight.
function makeBlockingPool() {
    const releases: Array<() => void> = [];
    const client = {
        query: vi.fn(async (sql: string) => {
            if (sql.includes('INSERT INTO consumed_events')) {
                await new Promise<void>((resolve) => releases.push(resolve));
                return { rowCount: 1, rows: [{ event_id: 'x' }] };
            }
            return { rowCount: 0, rows: [] };
        }),
        release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    return { pool, releases };
}

function envelopeMessage(_label: string): ConsumeMessage {
    const body = {
        eventId: randomUUID(),
        eventType: 'test.thing',
        eventVersion: 1,
        aggregateType: 'thing',
        aggregateId: 'a1',
        occurredAt: new Date().toISOString(),
        payload: {},
    };
    return { content: Buffer.from(JSON.stringify(body)), fields: { exchange: 'test.events', routingKey: 'test.thing', redelivered: false, deliveryTag: 1, consumerTag: 'test' }, properties: {} } as ConsumeMessage;
}

function makeConsumer(
    newChannel: ReturnType<typeof vi.fn>,
    opts: { gate?: ActivityGate; pool?: unknown; pauseDrainTimeoutMs?: number } = {},
) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const consumer = new EventConsumer({
        consumerName: 'test-consumer',
        pool: (opts.pool ?? {}) as Pool,
        connectionManager: {
            ensureConnected: vi.fn().mockResolvedValue(undefined),
            newChannel,
        } as unknown as ConnectionManager,
        queue: 'test.queue',
        bindings: [{ exchange: 'test.events', routingKey: '#' }],
        handlers: [
            {
                eventType: 'test.thing',
                eventVersion: 1,
                payloadSchema: { parse: (v: unknown) => v } as never,
                handle: async () => {},
            },
        ],
        logger: logger as unknown as ILogger,
        gate: opts.gate,
        pauseDrainTimeoutMs: opts.pauseDrainTimeoutMs,
    });
    return { consumer, logger };
}

describe('EventConsumer activity gate', () => {
    it('inactive at start: asserts topology but never consumes', async () => {
        const ch = makeChannel();
        const { gate } = makeGate(false);
        const { consumer } = makeConsumer(vi.fn().mockResolvedValue(ch), { gate });

        await consumer.start();

        expect(ch.assertQueue).toHaveBeenCalledWith('test.queue', expect.anything());
        expect(ch.bindQueue).toHaveBeenCalledWith('test.queue', 'test.events', '#');
        expect(ch.consume).not.toHaveBeenCalled();
        expect(consumer.getStatus()).toEqual({ queue: 'test.queue', state: 'paused', inFlight: 0 });
    });

    it('gate change pauses (cancel, channel kept) and resumes (consume again on same channel)', async () => {
        const ch = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch);
        const { gate, set } = makeGate(true);
        const { consumer } = makeConsumer(newChannel, { gate });
        await consumer.start();
        expect(ch.consume).toHaveBeenCalledTimes(1);

        set(false);
        await vi.waitFor(() => expect(ch.cancel).toHaveBeenCalledWith('tag-1'));
        expect(ch.close).not.toHaveBeenCalled();
        expect(consumer.getStatus().state).toBe('paused');

        set(true);
        await vi.waitFor(() => expect(ch.consume).toHaveBeenCalledTimes(2));
        expect(newChannel).toHaveBeenCalledTimes(1);
        expect(consumer.getStatus().state).toBe('active');
    });

    it('pause() waits for the in-flight handler before resolving', async () => {
        const ch = makeChannel();
        const { pool, releases } = makeBlockingPool();
        const { consumer } = makeConsumer(vi.fn().mockResolvedValue(ch), { pool });
        await consumer.start();

        ch.deliveries[0]!(envelopeMessage('e1'));
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        expect(consumer.getStatus().inFlight).toBe(1);

        let resolved = false;
        const paused = consumer.pause().then(() => {
            resolved = true;
        });
        await vi.waitFor(() => expect(ch.cancel).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(resolved).toBe(false);

        releases[0]!();
        await paused;
        expect(resolved).toBe(true);
        expect(ch.ack).toHaveBeenCalledTimes(1);
        expect(consumer.getStatus().inFlight).toBe(0);
    });

    it('a delivery racing the cancel is still dispatched and acked', async () => {
        const ch = makeChannel();
        const { pool, releases } = makeBlockingPool();
        const { consumer } = makeConsumer(vi.fn().mockResolvedValue(ch), { pool });
        await consumer.start();
        ch.cancel.mockImplementationOnce(async () => {
            // Delivered after basic.cancel was sent, before cancel-ok.
            ch.deliveries[0]!(envelopeMessage('late'));
        });

        const paused = consumer.pause();
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        releases[0]!();
        await paused;

        expect(ch.ack).toHaveBeenCalledTimes(1);
        expect(ch.nack).not.toHaveBeenCalled();
    });

    it('drain timeout resolves pause() with a warning and leaves the handler counted', async () => {
        vi.useFakeTimers();
        const ch = makeChannel();
        const { pool, releases } = makeBlockingPool();
        const { consumer, logger } = makeConsumer(vi.fn().mockResolvedValue(ch), {
            pool,
            pauseDrainTimeoutMs: 5_000,
        });
        await consumer.start();
        ch.deliveries[0]!(envelopeMessage('slow'));
        await vi.advanceTimersByTimeAsync(0);
        expect(releases).toHaveLength(1);

        const paused = consumer.pause();
        await vi.advanceTimersByTimeAsync(5_000);
        await paused;

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('drain timed out'));
        expect(consumer.getStatus().inFlight).toBe(1);
    });

    it("our own cancel is not treated as a broker cancel (null message ignored while paused)", async () => {
        vi.useFakeTimers();
        const ch = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch);
        const { consumer, logger } = makeConsumer(newChannel);
        await consumer.start();

        ch.cancel.mockImplementationOnce(async () => {
            ch.deliveries[0]!(null);
        });
        await consumer.pause();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('cancelled by broker'),
        );
        expect(ch.close).not.toHaveBeenCalled();
        expect(newChannel).toHaveBeenCalledTimes(1);
    });

    it('a real broker cancel while active still re-subscribes', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { consumer } = makeConsumer(newChannel);
        await consumer.start();

        ch1.deliveries[0]!(null);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(ch2.consume).toHaveBeenCalledTimes(1);
    });

    it('a channel lost while paused reconnects without consuming', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { consumer } = makeConsumer(newChannel);
        await consumer.start();
        await consumer.pause();

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);

        expect(newChannel).toHaveBeenCalledTimes(2);
        expect(ch2.assertQueue).toHaveBeenCalled();
        expect(ch2.consume).not.toHaveBeenCalled();
        expect(consumer.getStatus().state).toBe('paused');
    });

    it('resume() after the channel was lost routes through reconnect and consumes', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi
            .fn()
            .mockResolvedValueOnce(ch1)
            .mockRejectedValueOnce(new Error('broker down'))
            .mockResolvedValueOnce(ch2);
        const { consumer } = makeConsumer(newChannel);
        await consumer.start();
        await consumer.pause();
        ch1.emit('close'); // reconnect scheduled; first attempt fails

        await vi.advanceTimersByTimeAsync(1_000);
        await consumer.resume();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(ch2.consume).toHaveBeenCalledTimes(1);
        expect(consumer.getStatus().state).toBe('active');
    });

    it('rapid pause/resume flaps settle on the last requested state', async () => {
        const ch = makeChannel();
        const { consumer } = makeConsumer(vi.fn().mockResolvedValue(ch));
        await consumer.start();

        const ops = [consumer.pause(), consumer.resume(), consumer.pause()];
        await Promise.all(ops);

        expect(consumer.getStatus().state).toBe('paused');
        expect(ch.cancel).toHaveBeenCalledTimes(1);
        expect(ch.consume).toHaveBeenCalledTimes(1);
    });

    it('stop() while paused does not resume and closes cleanly', async () => {
        const ch = makeChannel();
        const { consumer } = makeConsumer(vi.fn().mockResolvedValue(ch));
        await consumer.start();
        await consumer.pause();
        await consumer.stop();
        await consumer.resume();

        expect(ch.consume).toHaveBeenCalledTimes(1);
        expect(ch.close).toHaveBeenCalled();
    });
});
