import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OutboxRelay } from '../relay.js';
import type { OutboxRelayOpts } from '../relay.js';

// tick() reschedules itself; fake timers keep those schedules inert so
// manually driven ticks don't spawn real 500ms follow-ups.
afterEach(() => {
    vi.useRealTimers();
});

/**
 * The ConnectionManager auto-reconnects the *connection* after a socket drop,
 * but channels die with the old connection and are not resurrected. These
 * tests pin the relay's recovery contract: a dead channel is dropped on its
 * 'close' event and a fresh one (with the exchange re-asserted) is acquired
 * on the next poll — instead of publishing into the dead channel forever
 * (observed in dev as one IllegalOperationError per 500ms tick while outbox
 * rows backed up, ~615K log lines/day).
 */

function makeChannel() {
    const ch = new EventEmitter() as EventEmitter & {
        assertExchange: ReturnType<typeof vi.fn>;
        publish: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
    };
    ch.assertExchange = vi.fn().mockResolvedValue({});
    ch.publish = vi.fn().mockReturnValue(true);
    ch.close = vi.fn().mockResolvedValue(undefined);
    return ch;
}

const ROW = {
    event_id: '4d1c1adc-0000-4000-8000-000000000001',
    aggregate_type: 'program',
    aggregate_id: 'p-1',
    event_type: 'program.created',
    event_version: 1,
    payload: { id: 'p-1' },
    meta: null,
    occurred_at: new Date('2026-07-01T00:00:00Z'),
    attempts: 0,
};

function makePgPool() {
    const client = {
        query: vi.fn(async (sql: string) => {
            if (String(sql).includes('FROM outbox_event')) {
                return { rows: [ROW], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
    };
    return { pool: { connect: vi.fn().mockResolvedValue(client) }, client };
}

function makeRelay(newChannel: ReturnType<typeof vi.fn>) {
    const { pool } = makePgPool();
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const connectionManager = {
        ensureConnected: vi.fn().mockResolvedValue(undefined),
        newChannel,
    };
    const relay = new OutboxRelay({
        pool: pool as unknown as OutboxRelayOpts['pool'],
        connectionManager: connectionManager as unknown as OutboxRelayOpts['connectionManager'],
        exchange: 'test.events',
        logger: logger as unknown as OutboxRelayOpts['logger'],
    });
    // Mark "started" — ensureChannel refuses to cache a channel acquired
    // after stop(), and tick() suppresses post-stop failure logs.
    (relay as unknown as { running: boolean }).running = true;
    return { relay, connectionManager, logger };
}

const drain = (relay: OutboxRelay) =>
    (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();

const tick = (relay: OutboxRelay) =>
    (relay as unknown as { tick: () => Promise<void> }).tick();

describe('OutboxRelay channel recovery', () => {
    it("re-acquires a channel after 'close' and publishes on the new one", async () => {
        const ch1 = makeChannel();
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { relay, connectionManager } = makeRelay(newChannel);

        await drain(relay);
        expect(ch1.publish).toHaveBeenCalledTimes(1);

        ch1.emit('close');
        await drain(relay);

        expect(newChannel).toHaveBeenCalledTimes(2);
        expect(connectionManager.ensureConnected).toHaveBeenCalledTimes(2);
        expect(ch2.assertExchange).toHaveBeenCalledWith('test.events', 'topic', {
            durable: true,
        });
        expect(ch2.publish).toHaveBeenCalledTimes(1);
    });

    it('reuses the live channel across polls (no per-tick churn)', async () => {
        const ch1 = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch1);
        const { relay } = makeRelay(newChannel);

        await drain(relay);
        await drain(relay);

        expect(newChannel).toHaveBeenCalledTimes(1);
        expect(ch1.assertExchange).toHaveBeenCalledTimes(1);
    });

    it('does not cache a channel whose exchange assertion failed', async () => {
        const ch1 = makeChannel();
        ch1.assertExchange.mockRejectedValueOnce(new Error('PRECONDITION_FAILED (406)'));
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { relay } = makeRelay(newChannel);

        await expect(drain(relay)).rejects.toThrow(/406/);
        await drain(relay);

        expect(newChannel).toHaveBeenCalledTimes(2);
        expect(ch2.publish).toHaveBeenCalledTimes(1);
    });

    it("does not cache a channel whose 'close' fired during setup", async () => {
        const ch1 = makeChannel();
        // 'close' arrives before ensureChannel's assignment resumes — the
        // close listener's identity guard can't catch it.
        ch1.assertExchange.mockImplementationOnce(async () => {
            ch1.emit('close');
            return {};
        });
        const ch2 = makeChannel();
        const newChannel = vi.fn().mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
        const { relay } = makeRelay(newChannel);

        await expect(drain(relay)).rejects.toThrow(/closed during setup/);
        expect(ch1.close).toHaveBeenCalled();

        await drain(relay);
        expect(ch2.publish).toHaveBeenCalledTimes(1);
    });

    it('does not cache a channel acquired while stop() raced the setup', async () => {
        const ch1 = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch1);
        const { relay } = makeRelay(newChannel);
        (relay as unknown as { running: boolean }).running = false; // stop() won the race

        await expect(drain(relay)).rejects.toThrow(/stopped during channel setup/);
        expect(ch1.close).toHaveBeenCalled();
        expect((relay as unknown as { channel: unknown }).channel).toBeNull();
    });

    it("swallows channel 'error' events (no unhandled EventEmitter crash)", async () => {
        const ch1 = makeChannel();
        const newChannel = vi.fn().mockResolvedValue(ch1);
        const { relay, logger } = makeRelay(newChannel);

        await drain(relay);
        // Without a listener this would throw out of emit() and crash.
        ch1.emit('error', new Error('channel-level 406'));
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('channel error'),
        );
    });
});

describe('OutboxRelay failure-log throttling', () => {
    it('logs the first consecutive failure, then goes quiet until the heartbeat', async () => {
        vi.useFakeTimers();
        const newChannel = vi.fn().mockRejectedValue(new Error('broker down'));
        const { relay, logger } = makeRelay(newChannel);

        await tick(relay);
        await tick(relay);
        await tick(relay);

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('(1 consecutive)'),
            expect.any(Error),
        );
    });

    it('logs immediately when the failure mode changes mid-streak', async () => {
        vi.useFakeTimers();
        const newChannel = vi
            .fn()
            .mockRejectedValueOnce(new Error('broker down'))
            .mockRejectedValueOnce(new Error('broker down'))
            .mockRejectedValueOnce(new Error('pool exhausted'));
        const { relay, logger } = makeRelay(newChannel);

        await tick(relay); // 'broker down' → logged (new error)
        await tick(relay); // same error → throttled
        await tick(relay); // 'pool exhausted' → logged (changed error)

        expect(logger.error).toHaveBeenCalledTimes(2);
        const messages = logger.error.mock.calls.map((c) => (c[1] as Error).message);
        expect(messages).toEqual(['broker down', 'pool exhausted']);
    });

    it('resets the failure counter after a successful poll', async () => {
        vi.useFakeTimers();
        const ch1 = makeChannel();
        const newChannel = vi
            .fn()
            .mockRejectedValueOnce(new Error('broker down'))
            .mockResolvedValue(ch1);
        const { relay, logger } = makeRelay(newChannel);

        await tick(relay); // fails → logs (1 consecutive)
        await tick(relay); // recovers
        ch1.emit('close');
        newChannel.mockRejectedValueOnce(new Error('broker down again'));
        await tick(relay); // fails → logs (1 consecutive) again

        expect(logger.error).toHaveBeenCalledTimes(2);
        const messages = logger.error.mock.calls.map((c) => String(c[0]));
        expect(messages.every((m) => m.includes('(1 consecutive)'))).toBe(true);
    });
});
