import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../relay.js';
import type { OutboxRelayOpts } from '../relay.js';

afterEach(() => {
    vi.useRealTimers();
});

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

type MockLeaderClient = EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
};

// Simulates pg_try_advisory_lock/pg_advisory_unlock via a shared JS boolean
// standing in for server-side advisory-lock state. This is enough to test
// the RELAY'S OWN branch logic (a losing instance sets isLeader=false and
// skips the outbox query; the winner holds its client until stop()) — it is
// NOT proof of real cross-process mutual exclusion, which Postgres itself
// guarantees, not this mock.
//
// A real EventEmitter (not `on: vi.fn()`) so `client.on('error', …)` /
// `client.removeListener('error', …)` behave like the real pg.PoolClient —
// needed to exercise OutboxRelay's own listener-cleanup logic, not just stub
// it out unreachably.
function makeClient(lockState: { locked: boolean }): MockLeaderClient {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
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
    }) as unknown as MockLeaderClient;
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

const leaderClient = (relay: OutboxRelay) =>
    (relay as unknown as { leaderClient: MockLeaderClient | null }).leaderClient;

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

    it('releases the advisory lock and the error listener on stop() so a waiting relay can take over', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const relayA = makeRelay(pool, makeLogger());
        const relayB = makeRelay(pool, makeLogger());
        (relayA as unknown as { running: boolean }).running = true;
        (relayB as unknown as { running: boolean }).running = true;

        await pursue(relayA);
        expect(lockState.locked).toBe(true);
        const clientA = leaderClient(relayA);
        expect(clientA?.listenerCount('error')).toBe(1);

        await relayA.stop();
        expect(lockState.locked).toBe(false);
        expect(clientA?.listenerCount('error')).toBe(0);

        await pursue(relayB);
        expect(isLeader(relayB)).toBe(true);

        await relayB.stop();
    });

    it('destroys (not recycles) the client when the unlock query itself fails on stop()', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const relay = makeRelay(pool, makeLogger());
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        const client = leaderClient(relay);
        const unlockErr = new Error('connection terminated unexpectedly');
        client!.query.mockImplementation(async (sql: string) => {
            if (sql.includes('pg_advisory_unlock')) throw unlockErr;
            return { rows: [] };
        });

        await relay.stop();

        // A dead connection must be destroyed via release(err), not recycled
        // via release() — recycling a connection that just failed a query
        // hands the next pool.connect() caller a broken client.
        expect(client?.release).toHaveBeenCalledWith(unlockErr);
    });

    it('a leader connection error removes its listener, releases the client WITH the error, and re-acquires', async () => {
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
        const deadClient = leaderClient(relay);
        expect(deadClient?.listenerCount('error')).toBe(1);

        const err = new Error('connection terminated unexpectedly');
        deadClient?.emit('error', err);

        // The handler runs synchronously up to (but not including) the
        // reacquire it kicks off — no `await` needed to observe these.
        expect(deadClient?.listenerCount('error')).toBe(0); // removed itself
        expect(deadClient?.release).toHaveBeenCalledWith(err); // release(err), not release() — frees the pool slot
        expect(isLeader(relay)).toBe(false);
        expect(leaderClient(relay)).toBeNull();
        expect(metrics.onLeaderLost).toHaveBeenCalledTimes(1);

        // A dead connection drops its session-level advisory lock server-side;
        // the mock mirrors that so the scheduled reacquire can succeed.
        lockState.locked = false;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(isLeader(relay)).toBe(true);
        expect(metrics.onLeaderAcquired).toHaveBeenCalledTimes(2);

        await relay.stop();
    });

    it('a stale error listener firing after a new leadership cycle does not clobber the new leader', async () => {
        // Regression guard: without the `leaderClient === client` identity
        // check, a listener that outlives its own client (e.g. it fires just
        // after a reacquire cycle already installed a new client) would null
        // out isLeader/leaderClient for the CURRENT leader, causing
        // fleet-wide permanent leadership loss.
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const relay = makeRelay(pool, makeLogger());
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        const staleClient = leaderClient(relay);
        expect(isLeader(relay)).toBe(true);

        // Simulate a new leadership cycle already having installed a
        // different client by the time the stale one's error handler fires.
        const replacement = makeClient(lockState);
        (relay as unknown as { leaderClient: unknown }).leaderClient = replacement;

        staleClient?.emit('error', new Error('stale connection error'));

        expect(staleClient?.release).toHaveBeenCalled(); // the dead client is still cleaned up
        expect(leaderClient(relay)).toBe(replacement); // untouched
        expect(isLeader(relay)).toBe(true); // untouched

        await relay.stop();
    });
});
