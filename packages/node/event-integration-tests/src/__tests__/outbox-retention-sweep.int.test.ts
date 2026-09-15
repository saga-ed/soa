import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import {
    OUTBOX_EVENT_ARCHIVE_SQL,
    OUTBOX_EVENT_SQL,
    OutboxRetention,
    type OutboxRetentionOptions,
} from '@saga-ed/soa-event-outbox';

/**
 * Proves OutboxRetention.sweepOnce() against a real Postgres table with a
 * genuinely locked row — a plain mocked-row unit test can assert the SQL
 * text but can't prove the DELETE actually skips (rather than blocks on) a
 * row held by another open transaction. This is the regression guard for
 * that: sweepBatch's `candidates` CTE uses FOR UPDATE SKIP LOCKED, so this
 * test hangs (and fails on its own timeout) if that clause regresses.
 */
const UNPUBLISHED_ID = '00000000-0000-4000-8000-000000000001';
const PUBLISHED_RECENT_ID = '00000000-0000-4000-8000-000000000002';
const PUBLISHED_OLD_UNLOCKED_ID = '00000000-0000-4000-8000-000000000003';
const PUBLISHED_OLD_LOCKED_ID = '00000000-0000-4000-8000-000000000004';

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

async function insertRow(
    pool: Pool,
    eventId: string,
    publishedAtExpr: string | null,
): Promise<void> {
    await pool.query(
        `INSERT INTO outbox_event (
            event_id, aggregate_type, aggregate_id, event_type,
            event_version, payload, occurred_at, published_at
        ) VALUES (
            $1::uuid, 'thing', $1, 'thing.created', 1, '{}'::jsonb, NOW(),
            ${publishedAtExpr ?? 'NULL'}
        )`,
        [eventId],
    );
}

describe('OutboxRetention sweep (integration)', () => {
    let infra: InfraHandle;
    let pool: Pool;

    beforeAll(async () => {
        infra = await startInfra();
        const dbUrl = await infra.createDatabase('retention_sweep_test');
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
        await infra.runSql(dbUrl, OUTBOX_EVENT_ARCHIVE_SQL);
        pool = new Pool({ connectionString: dbUrl, max: 5 });
    }, 120_000);

    afterAll(async () => {
        await pool?.end();
        await infra?.stop();
    });

    it(
        'moves only unlocked rows past the TTL, skipping a row held by an open FOR UPDATE transaction',
        async () => {
            await insertRow(pool, UNPUBLISHED_ID, null);
            await insertRow(pool, PUBLISHED_RECENT_ID, `NOW() - INTERVAL '2 hours'`);
            await insertRow(pool, PUBLISHED_OLD_UNLOCKED_ID, `NOW() - INTERVAL '2 days'`);
            await insertRow(pool, PUBLISHED_OLD_LOCKED_ID, `NOW() - INTERVAL '2 days'`);

            const lockHolder: PoolClient = await pool.connect();
            let lockHolderReleased = false;
            await lockHolder.query('BEGIN');
            await lockHolder.query('SELECT * FROM outbox_event WHERE event_id = $1 FOR UPDATE', [
                PUBLISHED_OLD_LOCKED_ID,
            ]);

            try {
                const retention = new OutboxRetention({
                    pool,
                    logger: makeLogger() as unknown as OutboxRetentionOptions['logger'],
                    retentionDays: 1,
                });
                const archived = await retention.sweepOnce();

                expect(archived).toBe(1);

                const { rows: remaining } = await pool.query<{ event_id: string }>(
                    'SELECT event_id FROM outbox_event ORDER BY event_id',
                );
                expect(remaining.map((r) => r.event_id)).toEqual(
                    [UNPUBLISHED_ID, PUBLISHED_RECENT_ID, PUBLISHED_OLD_LOCKED_ID].sort(),
                );

                const { rows: archivedRows } = await pool.query<{ event_id: string }>(
                    'SELECT event_id FROM outbox_event_archive',
                );
                expect(archivedRows.map((r) => r.event_id)).toEqual([PUBLISHED_OLD_UNLOCKED_ID]);

                // Once the lock releases, the previously-skipped row is picked
                // up on the very next sweep — SKIP LOCKED defers it, it never
                // drops it.
                await lockHolder.query('COMMIT');
                lockHolder.release();
                lockHolderReleased = true;

                const archivedSecondSweep = await retention.sweepOnce();
                expect(archivedSecondSweep).toBe(1);

                const { rows: archivedAfterUnlock } = await pool.query<{ event_id: string }>(
                    'SELECT event_id FROM outbox_event_archive ORDER BY event_id',
                );
                expect(archivedAfterUnlock.map((r) => r.event_id)).toEqual(
                    [PUBLISHED_OLD_UNLOCKED_ID, PUBLISHED_OLD_LOCKED_ID].sort(),
                );
            } finally {
                if (!lockHolderReleased) {
                    await lockHolder.query('ROLLBACK').catch(() => {});
                    lockHolder.release();
                }
            }
        },
        20_000,
    );
});
