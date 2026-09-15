import { afterEach, describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../relay.js';
import type { OutboxRelayOpts } from '../relay.js';

afterEach(() => {
    vi.useRealTimers();
});

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

// Simulates pg_try_advisory_lock/pg_advisory_unlock via a shared JS boolean
// standing in for server-side advisory-lock state. This is enough to test
// the RELAY'S OWN branch logic (a losing instance sets isLeader=false and
// skips the outbox query; the winner holds its client until stop()) — it is
// NOT proof of real cross-process mutual exclusion, which Postgres itself
// guarantees, not this mock.
function makeClient(lockState: { locked: boolean }) {
    return {
        query: vi.fn(async (sql: string) => {
            if (sql.includes('pg_try_advisory_lock')) {
                if (lockState.locked) return { rows: [{ locked: false }] };
                lockState.locked = true;
                return { rows: [{ locked: true }] };
            }
            if (sql.includes('pg_advisory_unlock')) {
                lockState.locked = false;
                return { rows: [{}] };
            }
            return { rows: [] };
        }),
        release: vi.fn(),
        on: vi.fn(),
    };
}

function makePool(lockState: { locked: boolean }) {
    return { connect: vi.fn(async () => makeClient(lockState)) };
}

function makeRelay(pool: unknown, logger: ReturnType<typeof makeLogger>, metrics?: OutboxRelayOpts['metrics']) {
    return new OutboxRelay({
        pool: pool as OutboxRelayOpts['pool'],
        connectionManager: {} as unknown as OutboxRelayOpts['connectionManager'],
        exchange: 'test.events',
        logger: logger as unknown as OutboxRelayOpts['logger'],
        metrics,
    });
}

const pursue = (relay: OutboxRelay) =>
    (relay as unknown as { pursueLeadership: () => Promise<void> }).pursueLeadership();

const isLeader = (relay: OutboxRelay) => (relay as unknown as { isLeader: boolean }).isLeader;

describe('OutboxRelay leader election', () => {
    it('acquires the lock when uncontended and reports it via metrics', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const logger = makeLogger();
        const metrics = {
            onPublished: vi.fn(),
            onPublishFailed: vi.fn(),
            onLeaderAcquired: vi.fn(),
            onLeaderLost: vi.fn(),
        };
        const relay = makeRelay(pool, logger, metrics);
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);

        expect(isLeader(relay)).toBe(true);
        expect(metrics.onLeaderAcquired).toHaveBeenCalledTimes(1);

        await relay.stop();
        expect(lockState.locked).toBe(false);
    });

    it('a losing relay stays non-leader and its tick() skips the outbox query', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const relayA = makeRelay(pool, makeLogger());
        const relayB = makeRelay(pool, makeLogger());
        (relayA as unknown as { running: boolean }).running = true;
        (relayB as unknown as { running: boolean }).running = true;

        await pursue(relayA);
        await pursue(relayB);

        expect(isLeader(relayA)).toBe(true);
        expect(isLeader(relayB)).toBe(false);

        // tick() with no channel/connectionManager wired would throw trying to
        // ensureChannel if it fell through to drainBatch — resolving cleanly
        // proves the !isLeader branch short-circuited before that point.
        const tick = (relay: OutboxRelay) => (relay as unknown as { tick: () => Promise<void> }).tick();
        await expect(tick(relayB)).resolves.toBeUndefined();

        await relayA.stop();
        await relayB.stop();
    });

    it('schedules a leader-poll retry instead of hammering the lock when already held', async () => {
        vi.useFakeTimers();
        const lockState = { locked: true }; // held by "someone else"
        const pool = makePool(lockState);
        const relay = makeRelay(pool, makeLogger());
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);

        expect(isLeader(relay)).toBe(false);
        expect((relay as unknown as { leaderTimer: unknown }).leaderTimer).not.toBeNull();

        await relay.stop();
    });

    it('releases the advisory lock on stop() so a waiting relay can take over', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const relayA = makeRelay(pool, makeLogger());
        const relayB = makeRelay(pool, makeLogger());
        (relayA as unknown as { running: boolean }).running = true;
        (relayB as unknown as { running: boolean }).running = true;

        await pursue(relayA);
        expect(lockState.locked).toBe(true);

        await relayA.stop();
        expect(lockState.locked).toBe(false);

        await pursue(relayB);
        expect(isLeader(relayB)).toBe(true);

        await relayB.stop();
    });
});
