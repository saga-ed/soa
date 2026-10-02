import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../relay.js';
import type { OutboxRelayOpts, OutboxMetrics } from '../relay.js';

afterEach(() => {
    vi.useRealTimers();
});

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function makeMetrics(): Required<Pick<OutboxMetrics, 'onPublished' | 'onPublishFailed'>> &
    OutboxMetrics {
    return {
        onPublished: vi.fn(),
        onPublishFailed: vi.fn(),
        onLeaderAcquired: vi.fn(),
        onLeaderLost: vi.fn(),
        onLeaderWaiting: vi.fn(),
        onLeaderYielded: vi.fn(),
    };
}

type MockLeaderClient = EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
};

// Same advisory-lock stand-in as relay-leader-election.unit.test.ts — see
// that file's comment for what this does and does not prove.
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

// A connectionManager whose newChannel() always rejects — the "dead channel
// that never recovers" scenario from the spec. drainBatch()'s very first
// line (`ensureChannel()`) then throws on every tick, without ever touching
// a second pg client, which is all the failure-streak tests need.
function makeDeadChannelConnectionManager() {
    return {
        ensureConnected: vi.fn(async () => {}),
        newChannel: vi.fn(async () => {
            throw new Error('channel dead');
        }),
    };
}

function makeRelay(
    pool: unknown,
    logger: ReturnType<typeof makeLogger>,
    metrics: OutboxRelayOpts['metrics'] | undefined,
    extra: Partial<OutboxRelayOpts> = {},
) {
    return new OutboxRelay({
        pool: pool as OutboxRelayOpts['pool'],
        connectionManager:
            (extra.connectionManager as OutboxRelayOpts['connectionManager']) ??
            (makeDeadChannelConnectionManager() as unknown as OutboxRelayOpts['connectionManager']),
        exchange: 'test.events',
        logger: logger as unknown as OutboxRelayOpts['logger'],
        metrics,
        ...extra,
    });
}

const pursue = (relay: OutboxRelay) =>
    (relay as unknown as { pursueLeadership: () => Promise<void> }).pursueLeadership();

const isLeader = (relay: OutboxRelay) => (relay as unknown as { isLeader: boolean }).isLeader;

const leaderClient = (relay: OutboxRelay) =>
    (relay as unknown as { leaderClient: MockLeaderClient | null }).leaderClient;

const scheduleNext = (relay: OutboxRelay) =>
    (relay as unknown as { scheduleNext: () => void }).scheduleNext();

const startLeaderWatchdog = (relay: OutboxRelay) =>
    (relay as unknown as { startLeaderWatchdog: () => void }).startLeaderWatchdog();

const yieldLeadership = (relay: OutboxRelay, reason: 'failures' | 'tick-timeout') =>
    (
        relay as unknown as {
            yieldLeadership: (r: 'failures' | 'tick-timeout') => Promise<void>;
        }
    ).yieldLeadership(reason);

const releaseLeadership = (relay: OutboxRelay, client: unknown) =>
    (
        relay as unknown as {
            releaseLeadership: (c: unknown) => Promise<void>;
        }
    ).releaseLeadership(client);

describe('OutboxRelay stale-leader watchdog', () => {
    it('yields leadership after a sustained tick-failure streak past leaderYieldAfterMs', async () => {
        vi.useFakeTimers();
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const logger = makeLogger();
        const metrics = makeMetrics();
        const relay = makeRelay(pool, logger, metrics, {
            pollIntervalMs: 1000,
            leaderYieldAfterMs: 5000,
            leaderPollIntervalMs: 2000,
            instanceLabel: 'blue',
        });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        expect(isLeader(relay)).toBe(true);
        scheduleNext(relay);

        // 1 failing tick/sec; the streak crosses 5000ms on the 6th tick.
        await vi.advanceTimersByTimeAsync(7000);

        expect(isLeader(relay)).toBe(false);
        expect(metrics.onLeaderYielded).toHaveBeenCalledWith('failures', 'blue');
        expect(metrics.onLeaderLost).toHaveBeenCalledWith('blue');

        await relay.stop();
    });

    it('does not yield while the failure streak is still below leaderYieldAfterMs', async () => {
        vi.useFakeTimers();
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const metrics = makeMetrics();
        const relay = makeRelay(pool, makeLogger(), metrics, {
            pollIntervalMs: 1000,
            leaderYieldAfterMs: 10_000,
            leaderPollIntervalMs: 2000,
        });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        scheduleNext(relay);

        await vi.advanceTimersByTimeAsync(5000); // 5 failing ticks, streak ~4000ms < 10000ms

        expect(isLeader(relay)).toBe(true);
        expect(metrics.onLeaderYielded).not.toHaveBeenCalled();

        await relay.stop();
    });

    it('does not yield on the fatal-pg-error path — that halts the relay outright instead', async () => {
        const lockState = { locked: false };
        const logger = makeLogger();
        const metrics = makeMetrics();
        const onFatalError = vi.fn();
        // A working channel this time — the fatal error needs to come from
        // the drainBatch query, not from ensureChannel().
        const channel = {
            on: vi.fn(),
            assertExchange: vi.fn(async () => {}),
            publish: vi.fn(() => true),
        };
        const connectionManager = {
            ensureConnected: vi.fn(async () => {}),
            newChannel: vi.fn(async () => channel),
        };
        let connectCalls = 0;
        const fatalErr = Object.assign(new Error('permission denied'), { code: '42501' });
        const pool2 = {
            connect: vi.fn(async () => {
                connectCalls++;
                if (connectCalls === 1) return makeClient(lockState); // leader-lock client
                // tx client for drainBatch
                return Object.assign(new EventEmitter(), {
                    query: vi.fn(async (sql: string) => {
                        if (sql.startsWith('SELECT event_id')) throw fatalErr;
                        return { rows: [] };
                    }),
                    release: vi.fn(),
                });
            }),
        };
        const relay = makeRelay(pool2, logger, metrics, {
            connectionManager: connectionManager as unknown as OutboxRelayOpts['connectionManager'],
            leaderYieldAfterMs: 0, // isolate: prove the fatal branch itself never yields
            onFatalError,
        });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        expect(isLeader(relay)).toBe(true);

        await (relay as unknown as { tick: () => Promise<void> }).tick();

        expect(onFatalError).toHaveBeenCalledWith(fatalErr);
        expect((relay as unknown as { running: boolean }).running).toBe(false);
        // Fatal path halts the relay but does not release the lock — a
        // config/permission error isn't something yielding to a sibling fixes.
        expect(isLeader(relay)).toBe(true);
        expect(metrics.onLeaderYielded).not.toHaveBeenCalled();
    });

    it('yields via the tick-timeout watchdog while a tick hangs, and the hung tick settling later does not drain again', async () => {
        vi.useFakeTimers();
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const metrics = makeMetrics();
        const relay = makeRelay(pool, makeLogger(), metrics, {
            pollIntervalMs: 1000,
            leaderTickTimeoutMs: 5000,
            leaderPollIntervalMs: 2000,
            // Kept well outside this test's timer-advance window so
            // re-acquisition (covered separately below) can't interfere
            // with the "does the settled tick drain again" assertion.
            leaderYieldBackoffMs: 60_000,
        });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        expect(isLeader(relay)).toBe(true);

        let resolveDrain: (() => void) | undefined;
        const drainBatchSpy = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveDrain = resolve;
                }),
        );
        (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch = drainBatchSpy;

        startLeaderWatchdog(relay);
        scheduleNext(relay);

        // Fire the first (now hung) tick.
        await vi.advanceTimersByTimeAsync(1000);
        expect(drainBatchSpy).toHaveBeenCalledTimes(1);
        expect(isLeader(relay)).toBe(true); // tick just started, watchdog hasn't tripped yet

        // Advance past leaderTickTimeoutMs — the watchdog should yield.
        // (The watchdog itself only samples every
        // min(leaderTickTimeoutMs / 4, 30_000) = 1250ms here, so give it a
        // full extra period of margin past the raw 5000ms threshold.)
        await vi.advanceTimersByTimeAsync(6250);
        expect(isLeader(relay)).toBe(false);
        expect(metrics.onLeaderYielded).toHaveBeenCalledWith('tick-timeout', undefined);

        // The wedged operation finally completes.
        resolveDrain?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Further poll ticks must not re-enter drainBatch — isLeader is
        // false until a fresh pursueLeadership() wins the lock again.
        await vi.advanceTimersByTimeAsync(3000);
        expect(drainBatchSpy).toHaveBeenCalledTimes(1);

        await relay.stop();
    });

    it('backs off leaderYieldBackoffMs after a yield, then re-acquires the lock', async () => {
        vi.useFakeTimers();
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const metrics = makeMetrics();
        const relay = makeRelay(pool, makeLogger(), metrics, {
            pollIntervalMs: 1000,
            leaderYieldAfterMs: 3000,
            leaderPollIntervalMs: 1000,
            leaderYieldBackoffMs: 4000,
        });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        expect(metrics.onLeaderAcquired).toHaveBeenCalledTimes(1);
        scheduleNext(relay);

        await vi.advanceTimersByTimeAsync(5000); // trips the failure-streak yield
        expect(isLeader(relay)).toBe(false);
        expect(metrics.onLeaderAcquired).toHaveBeenCalledTimes(1); // not yet re-acquired

        await vi.advanceTimersByTimeAsync(4000); // the backoff elapses
        expect(isLeader(relay)).toBe(true);
        expect(metrics.onLeaderAcquired).toHaveBeenCalledTimes(2);

        await relay.stop();
    });

    it('stop() during the yield backoff cancels the scheduled re-pursuit', async () => {
        vi.useFakeTimers();
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const metrics = makeMetrics();
        const relay = makeRelay(pool, makeLogger(), metrics, {
            pollIntervalMs: 1000,
            leaderYieldAfterMs: 3000,
            leaderPollIntervalMs: 1000,
            leaderYieldBackoffMs: 10_000,
        });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        scheduleNext(relay);

        await vi.advanceTimersByTimeAsync(5000); // trips the yield; backoff timer now pending
        expect(isLeader(relay)).toBe(false);
        expect((relay as unknown as { leaderTimer: unknown }).leaderTimer).not.toBeNull();

        await relay.stop();
        expect((relay as unknown as { leaderTimer: unknown }).leaderTimer).toBeNull();

        // Advancing well past the backoff must not re-acquire — stop() cancelled it.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(metrics.onLeaderAcquired).toHaveBeenCalledTimes(1);
        expect(isLeader(relay)).toBe(false);
    });

    it('yieldLeadership is idempotent — a second concurrent call is a no-op', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const metrics = makeMetrics();
        const relay = makeRelay(pool, makeLogger(), metrics, {});
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        const client = leaderClient(relay);
        expect(isLeader(relay)).toBe(true);

        const first = yieldLeadership(relay, 'failures');
        const second = yieldLeadership(relay, 'tick-timeout'); // races the first
        await Promise.all([first, second]);

        expect(metrics.onLeaderYielded).toHaveBeenCalledTimes(1);
        expect(metrics.onLeaderYielded).toHaveBeenCalledWith('failures', undefined);
        expect(metrics.onLeaderLost).toHaveBeenCalledTimes(1);
        expect(client?.release).toHaveBeenCalledTimes(1);

        await relay.stop();
    });

    it('onLeaderYielded receives both the reason and the configured instance label', async () => {
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const metrics = makeMetrics();
        const relay = makeRelay(pool, makeLogger(), metrics, { instanceLabel: 'green' });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        await yieldLeadership(relay, 'tick-timeout');

        expect(metrics.onLeaderYielded).toHaveBeenCalledWith('tick-timeout', 'green');
        expect(metrics.onLeaderLost).toHaveBeenCalledWith('green');

        await relay.stop();
    });

    it('releaseLeadership destroys (rather than hangs on) a client whose unlock query never resolves', async () => {
        vi.useFakeTimers();
        const lockState = { locked: false };
        const pool = makePool(lockState);
        const relay = makeRelay(pool, makeLogger(), undefined, { leaderPollIntervalMs: 100 });
        (relay as unknown as { running: boolean }).running = true;

        await pursue(relay);
        const client = leaderClient(relay);
        // Simulate the leader client itself being the wedged one: the
        // unlock query never settles.
        client!.query.mockImplementation((sql: string) => {
            if (sql.includes('pg_advisory_unlock')) return new Promise(() => {});
            return Promise.resolve({ rows: [] });
        });

        const releasePromise = releaseLeadership(relay, client);
        await vi.advanceTimersByTimeAsync(100);
        await releasePromise;

        expect(client!.release).toHaveBeenCalledTimes(1);
        const releaseArg = client!.release.mock.calls[0]?.[0];
        expect(releaseArg).toBeInstanceOf(Error);
        expect((releaseArg as Error).message).toMatch(/timed out/);
    });
});
