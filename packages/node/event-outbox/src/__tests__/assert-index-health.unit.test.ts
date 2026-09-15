import { describe, it, expect, vi } from 'vitest';
import { assertOutboxIndexHealth } from '../create-pool.js';

// pg_index/pg_class/pg_namespace joined shape the assert query returns.
function makePool(rows: Array<{ indexname: string; indexdef: string; indisvalid: boolean }>) {
    return { query: vi.fn().mockResolvedValue({ rows }) };
}

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

const partialDef = (name: string) =>
    `CREATE INDEX ${name} ON outbox_event USING btree (occurred_at) WHERE (published_at IS NULL)`;
const nonPartialDef = (name: string) => `CREATE INDEX ${name} ON outbox_event USING btree (occurred_at)`;
const publishedAtPartialDef = (name: string) =>
    `CREATE INDEX ${name} ON outbox_event USING btree (published_at) WHERE (published_at IS NOT NULL)`;

describe('assertOutboxIndexHealth', () => {
    it('passes silently when a valid partial index exists, matched on definition not name', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never),
        ).resolves.toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('throws with the create DDL when no partial index exists at all', async () => {
        const pool = makePool([]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_event_unpublished_idx/,
        );
    });

    it('throws with the SAME create DDL (no branching) when only the legacy non-partial index is present', async () => {
        const pool = makePool([
            { indexname: 'idx_outbox_event_unpublished', indexdef: nonPartialDef('idx_outbox_event_unpublished'), indisvalid: true },
        ]);
        const logger = makeLogger();
        // The new canonical name is different from the legacy one, so CREATE
        // INDEX ... IF NOT EXISTS under the new name is never a no-op here —
        // no repair/rename dance needed.
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_event_unpublished_idx/,
        );
    });

    it('throws when the only occurred_at index present is INVALID, even though its definition looks partial', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: false },
        ]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /outbox_event_unpublished_idx/,
        );
    });

    it("mode: 'warn' logs at error level instead of throwing when the index is missing", async () => {
        const pool = makePool([]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never, 'warn'),
        ).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("mode: 'off' skips the check without querying", async () => {
        const pool = makePool([]);
        const logger = makeLogger();
        await assertOutboxIndexHealth(pool as never, logger as never, 'off');
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('warns (not throws) when a valid partial index exists but the legacy non-partial one still lingers — the expected mid-migration state', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
            { indexname: 'idx_outbox_event_unpublished', indexdef: nonPartialDef('idx_outbox_event_unpublished'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never),
        ).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain('idx_outbox_event_unpublished');
        expect(logger.warn.mock.calls[0][0]).toContain('DROP INDEX CONCURRENTLY');
    });

    it('warns on a stray non-partial occurred_at index under an UNKNOWN name too — matched on shape, not the one known legacy name', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
            { indexname: 'some_other_occurred_at_idx', indexdef: nonPartialDef('some_other_occurred_at_idx'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await assertOutboxIndexHealth(pool as never, logger as never);
        expect(logger.warn.mock.calls[0][0]).toContain('some_other_occurred_at_idx');
    });

    it('scopes the lookup to current_schema()', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await assertOutboxIndexHealth(pool as never, logger as never);
        expect(pool.query.mock.calls[0][0]).toContain('current_schema()');
    });

    it('does not treat a partial index on a DIFFERENT column as satisfying the (occurred_at) requirement', async () => {
        const pool = makePool([
            {
                indexname: 'some_other_partial_idx',
                indexdef: 'CREATE INDEX some_other_partial_idx ON outbox_event USING btree (aggregate_id) WHERE (published_at IS NULL)',
                indisvalid: true,
            },
        ]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_event_unpublished_idx/,
        );
    });
});

describe('assertOutboxIndexHealth requirePublishedAtIndex (retention enabled)', () => {
    it('does not require the published_at index by default', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).resolves.toBeUndefined();
    });

    it('throws with the published_at index DDL when retention is enabled but the index is missing', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never, 'throw', true),
        ).rejects.toThrow(/CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_event_published_at_idx/);
    });

    it('passes silently when both partial indexes are present and valid', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
            {
                indexname: 'outbox_event_published_at_idx',
                indexdef: publishedAtPartialDef('outbox_event_published_at_idx'),
                indisvalid: true,
            },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never, 'throw', true),
        ).resolves.toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("mode: 'warn' logs at error level instead of throwing when the published_at index is missing", async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never, 'warn', true),
        ).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls[0][0]).toContain('outbox_event_published_at_idx');
    });

    it('does not treat a non-partial (full) index on published_at as satisfying the requirement', async () => {
        const pool = makePool([
            { indexname: 'outbox_event_unpublished_idx', indexdef: partialDef('outbox_event_unpublished_idx'), indisvalid: true },
            {
                indexname: 'some_full_published_at_idx',
                indexdef: 'CREATE INDEX some_full_published_at_idx ON outbox_event USING btree (published_at)',
                indisvalid: true,
            },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never, 'throw', true),
        ).rejects.toThrow(/outbox_event_published_at_idx/);
    });
});
