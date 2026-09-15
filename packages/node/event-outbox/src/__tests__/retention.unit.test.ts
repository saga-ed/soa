import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import { OutboxRetention } from '../retention.js';

function mockLogger(): ILogger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ILogger;
}

function stubPool(moved = 0, archived = moved): { pool: Pool; query: ReturnType<typeof vi.fn> } {
    const query = vi.fn().mockResolvedValue({ rows: [{ moved_count: moved, archived_count: archived }] });
    return { pool: { query } as unknown as Pool, query };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('OutboxRetention.sweepOnce', () => {
    it('moves rows via a DELETE...RETURNING feeding an INSERT into the archive table, bounded by batchSize', async () => {
        const { pool, query } = stubPool(3);
        const sweep = new OutboxRetention({ pool, logger: mockLogger(), retentionDays: 14, batchSize: 250 });

        expect(await sweep.sweepOnce()).toBe(3);
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toMatch(/delete\s+from\s+outbox_event/i);
        expect(sql).toMatch(/insert\s+into\s+outbox_event_archive\s*\(/i);
        expect(sql).not.toMatch(/select\s+\*/i);
        expect(sql).toMatch(/on conflict\s*\(event_id\)\s*do nothing/i);
        expect(sql).toMatch(/published_at\s+is\s+not\s+null/i);
        expect(sql).toMatch(/published_at\s*<\s*now\(\)\s*-/i);
        // TTL and batch size passed as parameters, not string-concatenated.
        expect(params).toEqual([14, 250]);
    });

    it('defaults to 7 days / 1000-row batches when not specified', async () => {
        const { pool, query } = stubPool(0);
        const sweep = new OutboxRetention({ pool, logger: mockLogger() });
        await sweep.sweepOnce();
        expect(query.mock.calls[0][1]).toEqual([7, 1000]);
    });

    it('returns 0 when nothing is old enough to move', async () => {
        const { pool } = stubPool(0);
        const sweep = new OutboxRetention({ pool, logger: mockLogger(), retentionDays: 7 });
        expect(await sweep.sweepOnce()).toBe(0);
    });

    it('treats a missing result row as 0 (driver may omit it)', async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });
        const sweep = new OutboxRetention({ pool: { query } as unknown as Pool, logger: mockLogger() });
        expect(await sweep.sweepOnce()).toBe(0);
    });

    it('swallows a sweep error (best-effort) — a failed sweep must not crash the service', async () => {
        const query = vi.fn().mockRejectedValue(new Error('connection reset'));
        const logger = mockLogger();
        const sweep = new OutboxRetention({ pool: { query } as unknown as Pool, logger });
        await expect(sweep.sweepOnce()).resolves.toBe(0);
        expect(logger.error).toHaveBeenCalled();
    });

    it('rejects a non-positive retentionDays', () => {
        expect(
            () => new OutboxRetention({ pool: stubPool().pool, logger: mockLogger(), retentionDays: 0 }),
        ).toThrow(/retentionDays/i);
        expect(
            () => new OutboxRetention({ pool: stubPool().pool, logger: mockLogger(), retentionDays: -1 }),
        ).toThrow(/retentionDays/i);
    });
});

describe('OutboxRetention.sweepOnce multi-batch drain', () => {
    it('loops batches within one call until a short batch signals the backlog is drained', async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ moved_count: 100, archived_count: 100 }] })
            .mockResolvedValueOnce({ rows: [{ moved_count: 100, archived_count: 100 }] })
            .mockResolvedValueOnce({ rows: [{ moved_count: 40, archived_count: 40 }] });
        const pool = { query } as unknown as Pool;
        const sweep = new OutboxRetention({ pool, logger: mockLogger(), batchSize: 100 });

        expect(await sweep.sweepOnce()).toBe(240);
        expect(query).toHaveBeenCalledTimes(3);
        for (const call of query.mock.calls) {
            expect(call[1]).toEqual([7, 100]);
        }
    });

    it('stops looping once maxRowsPerSweep is reached even if every batch stays full', async () => {
        // Mock respects the requested LIMIT ($2), same as a real query would —
        // otherwise this can't distinguish "capped by budget" from "capped by
        // an unrealistic mock".
        const query = vi.fn().mockImplementation(async (_sql: string, params: [number, number]) => {
            const n = Math.min(params[1], 100); // pretend ≥100 eligible rows always remain
            return { rows: [{ moved_count: n, archived_count: n }] };
        });
        const pool = { query } as unknown as Pool;
        const sweep = new OutboxRetention({
            pool,
            logger: mockLogger(),
            batchSize: 100,
            maxRowsPerSweep: 250,
        });

        expect(await sweep.sweepOnce()).toBe(250);
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls[0][1]).toEqual([7, 100]);
        expect(query.mock.calls[1][1]).toEqual([7, 100]);
        expect(query.mock.calls[2][1]).toEqual([7, 50]); // capped to the remaining budget
    });

    it('stops looping once the wall-clock budget elapses, even under maxRowsPerSweep', async () => {
        vi.useFakeTimers();
        const query = vi.fn().mockImplementation(async () => {
            vi.advanceTimersByTime(20_000);
            return { rows: [{ moved_count: 100, archived_count: 100 }] };
        });
        const pool = { query } as unknown as Pool;
        const sweep = new OutboxRetention({
            pool,
            logger: mockLogger(),
            batchSize: 100,
            maxSweepDurationMs: 30_000,
        });

        expect(await sweep.sweepOnce()).toBe(200);
        expect(query).toHaveBeenCalledTimes(2); // a 3rd batch would start at 40s, past the 30s budget
    });
});

describe('OutboxRetention.sweepOnce PK-conflict handling', () => {
    it('archives net-new rows and tolerates a replayed event_id already present in the archive', async () => {
        // moved=5 (all 5 removed from outbox_event) but archived=4 — one hit
        // ON CONFLICT DO NOTHING because it was already archived by an earlier
        // sweep (a replayed event_id re-entering the retention window).
        // Without ON CONFLICT DO NOTHING this would violate the archive's PK
        // and fail the whole batch's INSERT forever, since the same row keeps
        // sorting first by published_at on every retry.
        const query = vi.fn().mockResolvedValue({ rows: [{ moved_count: 5, archived_count: 4 }] });
        const pool = { query } as unknown as Pool;
        const sweep = new OutboxRetention({ pool, logger: mockLogger(), batchSize: 250 });

        await expect(sweep.sweepOnce()).resolves.toBe(4);
        // moved(5) < limit(250) — the loop still exits as a short batch even
        // though moved and archived differ.
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('caps the loop on maxRowsPerSweep using moved, not archived, when every row conflict-skips', async () => {
        // Every batch fully replays into the archive (archived=0), so if the
        // loop's budget were keyed on `archived` instead of `moved` it would
        // never trip and the loop would run until the wall-clock budget alone
        // stopped it — this pins the fix to `moved`.
        const query = vi.fn().mockImplementation(async (_sql: string, params: [number, number]) => {
            const n = Math.min(params[1], 100); // ≥100 eligible (but all-conflicting) rows always remain
            return { rows: [{ moved_count: n, archived_count: 0 }] };
        });
        const pool = { query } as unknown as Pool;
        const sweep = new OutboxRetention({
            pool,
            logger: mockLogger(),
            batchSize: 100,
            maxRowsPerSweep: 250,
        });

        await expect(sweep.sweepOnce()).resolves.toBe(0); // nothing net-new archived
        expect(query).toHaveBeenCalledTimes(3); // still capped at 250 moved (100+100+50)
        expect(query.mock.calls[2][1]).toEqual([7, 50]);
    });
});
