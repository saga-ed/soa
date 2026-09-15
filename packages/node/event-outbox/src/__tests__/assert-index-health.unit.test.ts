import { describe, it, expect, vi } from 'vitest';
import { assertOutboxIndexHealth } from '../create-pool.js';

// pg_index/pg_class/pg_namespace joined shape the assert query returns.
function makePool(rows: Array<{ indexname: string; indexdef: string; indisvalid: boolean }>) {
    return { query: vi.fn().mockResolvedValue({ rows }) };
}

function makeLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

const PARTIAL_DEF =
    'CREATE INDEX idx_outbox_event_unpublished ON outbox_event USING btree (occurred_at) WHERE (published_at IS NULL)';
const NON_PARTIAL_DEF = 'CREATE INDEX idx_outbox_event_unpublished ON outbox_event USING btree (occurred_at)';

describe('assertOutboxIndexHealth', () => {
    it('passes silently when a valid partial index exists', async () => {
        const pool = makePool([
            { indexname: 'idx_outbox_event_unpublished', indexdef: PARTIAL_DEF, indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never),
        ).resolves.toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('throws with the plain create DDL when no index of that name exists at all', async () => {
        const pool = makePool([]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_event_unpublished/,
        );
    });

    it('throws with the REPAIR ddl (not the plain create) when the canonical name is non-partial', async () => {
        const pool = makePool([
            { indexname: 'idx_outbox_event_unpublished', indexdef: NON_PARTIAL_DEF, indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /idx_outbox_event_unpublished_partial/,
        );
    });

    it('throws when the canonical name exists but is INVALID (interrupted CONCURRENTLY build)', async () => {
        const pool = makePool([
            { indexname: 'idx_outbox_event_unpublished', indexdef: PARTIAL_DEF, indisvalid: false },
        ]);
        const logger = makeLogger();
        await expect(assertOutboxIndexHealth(pool as never, logger as never)).rejects.toThrow(
            /idx_outbox_event_unpublished_partial/,
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

    it('warns (not throws) when a valid partial index exists under a NEW name but the broken legacy one lingers', async () => {
        const pool = makePool([
            {
                indexname: 'idx_outbox_event_unpublished_partial',
                indexdef: PARTIAL_DEF.replace('idx_outbox_event_unpublished', 'idx_outbox_event_unpublished_partial'),
                indisvalid: true,
            },
            { indexname: 'idx_outbox_event_unpublished', indexdef: NON_PARTIAL_DEF, indisvalid: true },
        ]);
        const logger = makeLogger();
        await expect(
            assertOutboxIndexHealth(pool as never, logger as never),
        ).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain('DROP INDEX CONCURRENTLY');
    });

    it('scopes the lookup to current_schema()', async () => {
        const pool = makePool([
            { indexname: 'idx_outbox_event_unpublished', indexdef: PARTIAL_DEF, indisvalid: true },
        ]);
        const logger = makeLogger();
        await assertOutboxIndexHealth(pool as never, logger as never);
        expect(pool.query.mock.calls[0][0]).toContain('current_schema()');
    });
});
