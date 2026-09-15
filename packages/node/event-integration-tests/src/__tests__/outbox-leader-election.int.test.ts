import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import { OUTBOX_EVENT_SQL, OutboxRelay, type OutboxRelayOpts } from '@saga-ed/soa-event-outbox';
import { pollUntil } from '../lib/wait.js';

/**
 * Proves the leader-election contract against a REAL Postgres advisory lock
 * (unit tests in event-outbox mock pg_try_advisory_lock with a JS boolean —
 * this validates the actual server-side mutual exclusion + the relay's
 * dead-connection recovery over a real socket):
 *   - exactly one of two OutboxRelay instances polls at a time
 *   - killing the leader's backend (pg_terminate_backend) lets the other
 *     side observe the failure and a leader re-emerges
 *   - neither relay's pg.Pool leaks a client across the failover
 */
function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

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

function makeConnectionManager() {
    return {
        ensureConnected: vi.fn().mockResolvedValue(undefined),
        newChannel: vi.fn().mockImplementation(async () => makeChannel()),
    };
}

function makeMetrics() {
    return {
        onPublished: vi.fn(),
        onPublishFailed: vi.fn(),
        onLeaderAcquired: vi.fn(),
        onLeaderLost: vi.fn(),
        onLeaderWaiting: vi.fn(),
    };
}

describe('OutboxRelay leader election (integration)', () => {
    let infra: InfraHandle;
    let dbUrl: string;

    beforeAll(async () => {
        infra = await startInfra();
        dbUrl = await infra.createDatabase('leader_election_test');
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
    }, 120_000);

    afterAll(async () => {
        await infra?.stop();
    });

    it(
        'exactly one relay leads; killing its connection fails over without leaking pool clients',
        async () => {
            const poolA = new Pool({
                connectionString: dbUrl,
                max: 4,
                application_name: 'relay-a-leader-test',
            });
            const poolB = new Pool({
                connectionString: dbUrl,
                max: 4,
                application_name: 'relay-b-leader-test',
            });
            const metricsA = makeMetrics();
            const metricsB = makeMetrics();
            // pollIntervalMs huge so tick()/drainBatch() never fires and can't
            // introduce a nondeterministic extra connection; leaderPollIntervalMs
            // small so the losing side's retry loop (and any failover) settles
            // well within the test's poll timeouts.
            const relayA = new OutboxRelay({
                pool: poolA,
                connectionManager: makeConnectionManager() as unknown as OutboxRelayOpts['connectionManager'],
                exchange: 'leader.test.events',
                logger: makeLogger() as unknown as OutboxRelayOpts['logger'],
                pollIntervalMs: 60_000,
                leaderPollIntervalMs: 250,
                metrics: metricsA,
            });
            const relayB = new OutboxRelay({
                pool: poolB,
                connectionManager: makeConnectionManager() as unknown as OutboxRelayOpts['connectionManager'],
                exchange: 'leader.test.events',
                logger: makeLogger() as unknown as OutboxRelayOpts['logger'],
                pollIntervalMs: 60_000,
                leaderPollIntervalMs: 250,
                metrics: metricsB,
            });

            try {
                await relayA.start();
                await relayB.start();

                await pollUntil(
                    () =>
                        Promise.resolve(
                            metricsA.onLeaderAcquired.mock.calls.length +
                                metricsB.onLeaderAcquired.mock.calls.length,
                        ),
                    (count) => count === 1,
                    { timeoutMs: 5_000 },
                );

                const aIsLeader = metricsA.onLeaderAcquired.mock.calls.length === 1;
                const bIsLeader = metricsB.onLeaderAcquired.mock.calls.length === 1;
                expect(aIsLeader).toBe(!bIsLeader); // exactly one leads

                const [leaderMetrics, leaderAppName] = aIsLeader
                    ? [metricsA, 'relay-a-leader-test']
                    : [metricsB, 'relay-b-leader-test'];
                const waiterMetrics = aIsLeader ? metricsB : metricsA;

                // Confirms — via the relay's public contract, not internal
                // state — that the non-leader actually attempted and lost,
                // i.e. exactly one instance polls outbox_event.
                await pollUntil(
                    () => Promise.resolve(waiterMetrics.onLeaderWaiting.mock.calls.length),
                    (count) => count > 0,
                    { timeoutMs: 3_000 },
                );

                // Baseline: each relay's pool holds exactly one client — the
                // leader's held actively, the waiter's parked idle and reused
                // every retry (pool.connect() reuses an idle client rather
                // than opening a new one).
                expect(poolA.totalCount).toBe(1);
                expect(poolB.totalCount).toBe(1);

                const probePool = new Pool({ connectionString: dbUrl });
                try {
                    const { rows } = await probePool.query<{ pid: number }>(
                        `SELECT pid FROM pg_stat_activity
                         WHERE application_name = $1
                           AND pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory')`,
                        [leaderAppName],
                    );
                    expect(rows).toHaveLength(1);
                    await probePool.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
                } finally {
                    await probePool.end();
                }

                await pollUntil(
                    () => Promise.resolve(leaderMetrics.onLeaderLost.mock.calls.length),
                    (count) => count > 0,
                    { timeoutMs: 5_000 },
                );

                await pollUntil(
                    () =>
                        Promise.resolve(
                            metricsA.onLeaderAcquired.mock.calls.length +
                                metricsB.onLeaderAcquired.mock.calls.length,
                        ),
                    (count) => count === 2,
                    { timeoutMs: 5_000 },
                );

                // No leaked clients on either pool after the failover settles,
                // regardless of which relay ended up leading the second round.
                await pollUntil(
                    () => Promise.resolve(poolA.totalCount + poolB.totalCount),
                    (sum) => sum === 2,
                    { timeoutMs: 3_000 },
                );
                expect(poolA.totalCount).toBe(1);
                expect(poolB.totalCount).toBe(1);
            } finally {
                await relayA.stop();
                await relayB.stop();
                await poolA.end();
                await poolB.end();
            }
        },
        120_000,
    );
});
