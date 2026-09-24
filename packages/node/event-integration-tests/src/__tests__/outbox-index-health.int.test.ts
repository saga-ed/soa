import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import {
    OUTBOX_EVENT_SQL,
    OUTBOX_UNPUBLISHED_INDEX_NAME,
    OUTBOX_UNPUBLISHED_INDEX_SQL,
    assertOutboxIndexHealth,
} from '@saga-ed/soa-event-outbox';

/**
 * assertOutboxIndexHealth matches on the index DEFINITION via
 * pg_get_indexdef, not a fixed name — a mocked-row unit test can assert the
 * package's own string-matching logic, but only a real catalog query proves
 * Postgres actually renders `pg_get_indexdef` in the shape (`(occurred_at)`,
 * `WHERE (published_at IS NULL)`) that logic assumes.
 */
type Logger = Parameters<typeof assertOutboxIndexHealth>[1];

function makeLogger(): Logger {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

describe('assertOutboxIndexHealth (integration)', () => {
    let infra: InfraHandle;
    let pool: Pool;

    beforeAll(async () => {
        infra = await startInfra();
        const dbUrl = await infra.createDatabase('index_health_test');
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
        // Drop the correct partial index OUTBOX_EVENT_SQL just created and
        // replace it with a partial index on the wrong column but the right
        // predicate — the shape a hand-rolled migration could plausibly
        // produce (partial-on-published_at-IS-NULL, but indexing the wrong
        // column instead of occurred_at).
        await infra.runSql(
            dbUrl,
            `DROP INDEX ${OUTBOX_UNPUBLISHED_INDEX_NAME};
             CREATE INDEX outbox_event_wrong_col_idx ON outbox_event (event_type) WHERE published_at IS NULL;`,
        );
        pool = new Pool({ connectionString: dbUrl });
    }, 120_000);

    afterAll(async () => {
        await pool?.end();
        await infra?.stop();
    });

    it('throws referencing the create-index DDL when the only partial index is on the wrong column', async () => {
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool, logger, 'throw')).rejects.toThrow(
            /no valid partial index on \(occurred_at\)/,
        );
        await expect(assertOutboxIndexHealth(pool, logger, 'throw')).rejects.toThrow(
            /CREATE INDEX CONCURRENTLY/,
        );
    });

    it('passes once the real migration DDL is applied, and the catalog renders the exact shape the check assumes', async () => {
        await pool.query(OUTBOX_UNPUBLISHED_INDEX_SQL);

        const { rows } = await pool.query<{ indexdef: string }>(
            `SELECT pg_get_indexdef(ix.indexrelid) AS indexdef
             FROM pg_index ix
             JOIN pg_class c ON c.oid = ix.indexrelid
             WHERE c.relname = $1`,
            [OUTBOX_UNPUBLISHED_INDEX_NAME],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.indexdef).toContain('(occurred_at)');
        expect(rows[0]!.indexdef).toContain('WHERE (published_at IS NULL)');

        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool, logger, 'throw')).resolves.toBeUndefined();
    });
});
