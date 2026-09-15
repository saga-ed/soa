import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import { OutboxRetention } from '../retention.js';

function mockLogger(): ILogger {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ILogger;
}

function stubPool(archived = 0): { pool: Pool; query: ReturnType<typeof vi.fn> } {
    const query = vi.fn().mockResolvedValue({ rowCount: archived, rows: [] });
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
        expect(sql).toMatch(/insert\s+into\s+outbox_event_archive/i);
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

    it('treats a null rowCount as 0 (driver may omit it)', async () => {
        const query = vi.fn().mockResolvedValue({ rowCount: null, rows: [] });
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

describe('OutboxRetention start/stop', () => {
    it('sweeps immediately on start, then on the interval, and stops cleanly', async () => {
        vi.useFakeTimers();
        const { pool, query } = stubPool(1);
        const sweep = new OutboxRetention({ pool, logger: mockLogger(), intervalMs: 1000 });

        sweep.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(query).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(query).toHaveBeenCalledTimes(2);

        sweep.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(query).toHaveBeenCalledTimes(2); // no further sweeps after stop
    });

    it('start() is idempotent (a second start does not double-schedule)', async () => {
        vi.useFakeTimers();
        const { pool, query } = stubPool(0);
        const sweep = new OutboxRetention({ pool, logger: mockLogger(), intervalMs: 1000 });
        sweep.start();
        sweep.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(query).toHaveBeenCalledTimes(2);
        sweep.stop();
    });
});
