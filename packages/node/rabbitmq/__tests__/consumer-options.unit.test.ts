import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageConsumer } from '../src/consumer.js';

function makeChannel() {
    const ch = new EventEmitter() as EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
    ch.assertQueue = vi.fn().mockResolvedValue({});
    ch.checkQueue = vi.fn().mockResolvedValue({});
    ch.prefetch = vi.fn().mockResolvedValue(undefined);
    ch.consume = vi.fn().mockResolvedValue({ consumerTag: 'tag' });
    ch.close = vi.fn().mockResolvedValue(undefined);
    ch.ack = vi.fn();
    ch.nack = vi.fn();
    return ch;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup(channels: ReturnType<typeof makeChannel>[]) {
    const newChannel = vi.fn();
    for (const c of channels) newChannel.mockResolvedValueOnce(c);
    const cm = { ensureConnected: vi.fn().mockResolvedValue(undefined), newChannel };
    const consumer = new MessageConsumer(cm as never);
    await consumer.requestChannel('c');
    return { consumer, cm };
}

const deliver = async (ch: ReturnType<typeof makeChannel>, msg: unknown) => {
    const cb = ch.consume.mock.calls.at(-1)![1] as (m: unknown) => Promise<void>;
    await cb(msg);
    await vi.advanceTimersByTimeAsync(0);
};

describe('queue option', () => {
    it('defaults to a bare assertQueue(name)', async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        await consumer.consumeFromQueue('c', 'q', async () => true);
        expect(ch.assertQueue).toHaveBeenCalledWith('q');
        expect(ch.checkQueue).not.toHaveBeenCalled();
    });

    it('{ args } asserts with those options, on subscribe and on every resubscribe', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { consumer } = await setup([ch1, ch2]);
        const args = { durable: true, arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 5 } };
        await consumer.consumeFromQueue('c', 'q', async () => true, { queue: { args } });
        expect(ch1.assertQueue).toHaveBeenCalledWith('q', args);
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.assertQueue).toHaveBeenCalledWith('q', args);
    });

    it('{ passive: true } uses checkQueue and never asserts', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { consumer } = await setup([ch1, ch2]);
        await consumer.consumeFromQueue('c', 'q', async () => true, { queue: { passive: true } });
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch1.checkQueue).toHaveBeenCalledWith('q');
        expect(ch2.checkQueue).toHaveBeenCalledWith('q');
        expect(ch1.assertQueue).not.toHaveBeenCalled();
        expect(ch2.assertQueue).not.toHaveBeenCalled();
    });
});

describe('ackMode', () => {
    it("default 'auto' acks on true and requeues on false", async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const handler = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await consumer.consumeFromQueue('c', 'q', handler);
        const a = { n: 1 };
        const b = { n: 2 };
        await deliver(ch, a);
        await deliver(ch, b);
        expect(ch.ack).toHaveBeenCalledWith(a);
        expect(ch.nack).toHaveBeenCalledWith(b, false, true);
    });

    it("'manual' passes the arrival channel and never acks or nacks", async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const handler = vi.fn().mockResolvedValue(undefined);
        await consumer.consumeFromQueue('c', 'q', handler, { ackMode: 'manual' });
        const m = { n: 1 };
        await deliver(ch, m);
        expect(handler).toHaveBeenCalledWith(m, ch);
        expect(ch.ack).not.toHaveBeenCalled();
        expect(ch.nack).not.toHaveBeenCalled();
    });

    it("'manual' handler gets the resubscribed channel after a loss", async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { consumer } = await setup([ch1, ch2]);
        const handler = vi.fn().mockResolvedValue(undefined);
        await consumer.consumeFromQueue('c', 'q', handler, { ackMode: 'manual' });
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        const m = { n: 1 };
        await deliver(ch2, m);
        expect(handler).toHaveBeenCalledWith(m, ch2);
    });

    it("'manual' throw is reported, leaves the message unacked and does not nack", async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const boom = new Error('boom');
        const onError = vi.fn();
        await consumer.consumeFromQueue('c', 'q', async () => Promise.reject(boom), { ackMode: 'manual', onError });
        const m = { n: 1 };
        await deliver(ch, m);
        expect(onError).toHaveBeenCalledWith(boom, m);
        expect(ch.ack).not.toHaveBeenCalled();
        expect(ch.nack).not.toHaveBeenCalled();
    });

    it("'manual' throw falls back to console.error", async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await consumer.consumeFromQueue('c', 'q', async () => Promise.reject(new Error('x')), { ackMode: 'manual' });
        await deliver(ch, { n: 1 });
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('prefetch', () => {
    it('is applied before consume, on the first channel and on each resubscribe channel', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { consumer } = await setup([ch1, ch2]);
        await consumer.consumeFromQueue('c', 'q', async () => true, { prefetch: 7 });
        expect(ch1.prefetch).toHaveBeenCalledWith(7);
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.prefetch).toHaveBeenCalledWith(7);
        expect(ch2.prefetch.mock.invocationCallOrder[0]).toBeLessThan(ch2.consume.mock.invocationCallOrder[0]!);
    });

    it('is not set when omitted', async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        await consumer.consumeFromQueue('c', 'q', async () => true);
        expect(ch.prefetch).not.toHaveBeenCalled();
    });
});

describe('resubscribe failure surfaces and backs off', () => {
    it('a persistent 406 on declare backs off (no hot loop) and shows in state()/isConsuming()', async () => {
        const ch1 = makeChannel();
        const bad = () => {
            const c = makeChannel();
            c.assertQueue.mockRejectedValue(new Error('PRECONDITION_FAILED - inequivalent arg'));
            return c;
        };
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockImplementation(async () => bad());
        const cm = { ensureConnected: vi.fn().mockResolvedValue(undefined), newChannel };
        const consumer = new MessageConsumer(cm as never);
        await consumer.requestChannel('c');
        await consumer.consumeFromQueue('c', 'q', async () => true);
        expect(consumer.isConsuming()).toBe(true);
        expect(consumer.state()).toEqual([{ channelName: 'c', status: 'subscribed', attempts: 0 }]);

        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // 1s,2s,4s,8s,16s then 30s steps: ~15 attempts in 5 min, not hundreds.
        const attempts = newChannel.mock.calls.length - 1;
        expect(attempts).toBeGreaterThan(5);
        expect(attempts).toBeLessThan(20);
        expect(consumer.isConsuming()).toBe(false);
        const [st] = consumer.state();
        expect(st).toMatchObject({ status: 'resubscribing', lastError: expect.stringContaining('PRECONDITION_FAILED') });
        expect(st!.attempts).toBeGreaterThan(5);
    });

    it('state clears after a successful resubscribe', async () => {
        const ch1 = makeChannel();
        const bad = makeChannel();
        bad.assertQueue.mockRejectedValue(new Error('406'));
        const good = makeChannel();
        const { consumer } = await setup([ch1, bad, good]);
        await consumer.consumeFromQueue('c', 'q', async () => true);
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000 + 2_000);
        expect(consumer.isConsuming()).toBe(true);
        expect(consumer.state()[0]).toEqual({ channelName: 'c', status: 'subscribed', attempts: 0 });
    });

    it('isConsuming is false after stop()', async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        await consumer.consumeFromQueue('c', 'q', async () => true);
        consumer.stop();
        expect(consumer.isConsuming()).toBe(false);
    });
});

describe('review hardening', () => {
    it('a synchronous throw, or a throwing onError, is contained (no unhandled rejection)', async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const sync = vi.fn(() => {
            throw new Error('sync');
        });
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        await consumer.consumeFromQueue('c', 'q', sync as never, {
            ackMode: 'manual',
            onError: () => {
                throw new Error('onError itself throws');
            },
        });
        await deliver(ch, { n: 1 });
        await vi.advanceTimersByTimeAsync(10);
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
        expect(ch.ack).not.toHaveBeenCalled();
        expect(ch.nack).not.toHaveBeenCalled();
    });

    it("'auto' reports a rejecting handler to a provided onError and leaves the message alone", async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const onError = vi.fn();
        await consumer.consumeFromQueue('c', 'q', async () => Promise.reject(new Error('x')), { onError });
        await deliver(ch, { n: 1 });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(ch.ack).not.toHaveBeenCalled();
        expect(ch.nack).not.toHaveBeenCalled();
    });

    it('isConsuming is false before any subscription exists', async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        expect(consumer.isConsuming()).toBe(false);
    });

    it('same queue and handler with different options registers both, and both are replayed', async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const { consumer } = await setup([ch1, ch2]);
        const h = vi.fn();
        await consumer.consumeFromQueue('c', 'q', h, { prefetch: 1 });
        await consumer.consumeFromQueue('c', 'q', h, { prefetch: 9 });
        ch1.emit('close');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ch2.consume).toHaveBeenCalledTimes(2);
        expect(ch2.prefetch).toHaveBeenCalledWith(1);
        expect(ch2.prefetch).toHaveBeenCalledWith(9);
    });

    it('accepts a union-typed ackMode (type check)', async () => {
        const ch = makeChannel();
        const { consumer } = await setup([ch]);
        const cfg: { ackMode: 'auto' | 'manual' } = { ackMode: 'manual' };
        await consumer.consumeFromQueue('c', 'q', (async () => undefined) as never, { ackMode: cfg.ackMode });
        expect(ch.consume).toHaveBeenCalled();
    });
});
