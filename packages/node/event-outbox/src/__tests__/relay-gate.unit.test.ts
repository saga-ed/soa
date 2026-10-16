import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelay, type ActivityGate, type OutboxRelayOpts } from '../relay.js';

afterEach(() => {
    vi.useRealTimers();
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

// Shared JS boolean standing in for the server-side advisory lock.
function makePool(lockState: { locked: boolean }) {
    return {
        connect: vi.fn(async () => {
            const client = Object.assign(new EventEmitter(), {
                query: vi.fn(async (sql: string) => {
                    if (sql.includes('pg_try_advisory_lock')) {
                        if (lockState.locked) return { rows: [{ locked: false }] };
                        lockState.locked = true;
                        return { rows: [{ locked: true }] };
                    }
                    if (sql.includes('pg_advisory_unlock')) {
                        lockState.locked = false;
                    }
                    return { rows: [] };
                }),
                release: vi.fn(),
            });
            return client;
        }),
    };
}

function makeRelay(
    pool: unknown,
    gate?: ActivityGate,
    extra: Partial<OutboxRelayOpts> = {},
) {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const channel = Object.assign(new EventEmitter(), {
        assertExchange: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
    });
    const metrics = {
        onPublished: vi.fn(),
        onPublishFailed: vi.fn(),
        onLeaderAcquired: vi.fn(),
        onLeaderLost: vi.fn(),
        onLeaderWaiting: vi.fn(),
    };
    const relay = new OutboxRelay({
        pool: pool as OutboxRelayOpts['pool'],
        connectionManager: {
            ensureConnected: vi.fn().mockResolvedValue(undefined),
            newChannel: vi.fn().mockResolvedValue(channel),
        } as unknown as OutboxRelayOpts['connectionManager'],
        exchange: 'test.events',
        logger: logger as unknown as OutboxRelayOpts['logger'],
        indexAssert: 'off',
        pollIntervalMs: 1_000_000,
        leaderPollIntervalMs: 1_000,
        gate,
        metrics,
        ...extra,
    });
    return { relay, logger, metrics };
}

describe('OutboxRelay activity gate', () => {
    it('inactive at start: never acquires the lock and reports standby', async () => {
        vi.useFakeTimers();
        const lock = { locked: false };
        const pool = makePool(lock);
        const { gate } = makeGate(false);
        const { relay, metrics } = makeRelay(pool, gate);

        await relay.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(pool.connect).not.toHaveBeenCalled();
        expect(lock.locked).toBe(false);
        expect(metrics.onLeaderAcquired).not.toHaveBeenCalled();
        expect(relay.getStatus()).toEqual({ state: 'standby' });
        await relay.stop();
    });

    it('becoming active acquires leadership', async () => {
        vi.useFakeTimers();
        const lock = { locked: false };
        const { gate, set } = makeGate(false);
        const { relay } = makeRelay(makePool(lock), gate);

        await relay.start();
        set(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(lock.locked).toBe(true);
        expect(relay.getStatus()).toEqual({ state: 'leader' });
        await relay.stop();
    });

    it('becoming inactive releases the lock and stops pursuing', async () => {
        vi.useFakeTimers();
        const lock = { locked: false };
        const pool = makePool(lock);
        const { gate, set } = makeGate(true);
        const { relay, metrics } = makeRelay(pool, gate);

        await relay.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(relay.getStatus()).toEqual({ state: 'leader' });

        set(false);
        await vi.advanceTimersByTimeAsync(0);

        expect(lock.locked).toBe(false);
        expect(metrics.onLeaderLost).toHaveBeenCalledTimes(1);
        expect(relay.getStatus()).toEqual({ state: 'standby' });

        const connects = pool.connect.mock.calls.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(pool.connect.mock.calls.length).toBe(connects);
        await relay.stop();
    });

    it('leadership moves between two relays when the gate flips', async () => {
        vi.useFakeTimers();
        const lock = { locked: false };
        const pool = makePool(lock);
        const a = makeGate(true);
        const b = makeGate(false);
        const relayA = makeRelay(pool, a.gate).relay;
        const relayB = makeRelay(pool, b.gate).relay;

        await relayA.start();
        await relayB.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(relayA.getStatus().state).toBe('leader');
        expect(relayB.getStatus().state).toBe('standby');

        a.set(false);
        b.set(true);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(relayA.getStatus().state).toBe('standby');
        expect(relayB.getStatus().state).toBe('leader');
        await relayA.stop();
        await relayB.stop();
    });

    it('a flip to inactive while the lock attempt is in flight releases the acquired lock', async () => {
        vi.useFakeTimers();
        const lock = { locked: false };
        const { gate, set } = makeGate(true);
        const pool = makePool(lock);
        const realConnect = pool.connect.getMockImplementation()!;
        pool.connect.mockImplementationOnce(async () => {
            set(false);
            return realConnect();
        });
        const { relay } = makeRelay(pool, gate);

        await relay.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(lock.locked).toBe(false);
        expect(relay.getStatus()).toEqual({ state: 'standby' });
        await relay.stop();
    });

    it('without a gate behaves as always-on', async () => {
        vi.useFakeTimers();
        const lock = { locked: false };
        const { relay } = makeRelay(makePool(lock));
        await relay.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(relay.getStatus()).toEqual({ state: 'leader' });
        await relay.stop();
    });
});
