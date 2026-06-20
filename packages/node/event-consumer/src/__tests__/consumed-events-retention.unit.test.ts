import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import { ConsumedEventsRetention } from '../consumed-events-retention.js';

function mockLogger(): ILogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function stubPool(deleted = 0): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rowCount: deleted, rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ConsumedEventsRetention.sweepOnce', () => {
  it('issues a single DELETE bounded by processed_at and the TTL parameter', async () => {
    const { pool, query } = stubPool(5);
    const sweep = new ConsumedEventsRetention({ pool, logger: mockLogger(), retentionDays: 30 });

    expect(await sweep.sweepOnce()).toBe(5);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/delete\s+from\s+consumed_events/i);
    expect(sql).toMatch(/processed_at\s*<\s*now\(\)\s*-/i);
    // TTL passed as an interval parameter (days), not string-concatenated.
    expect(params).toEqual([30]);
  });

  it('returns 0 when nothing is old enough to delete', async () => {
    const { pool } = stubPool(0);
    const sweep = new ConsumedEventsRetention({ pool, logger: mockLogger(), retentionDays: 30 });
    expect(await sweep.sweepOnce()).toBe(0);
  });

  it('treats a null rowCount as 0 (driver may omit it)', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: null, rows: [] });
    const sweep = new ConsumedEventsRetention({
      pool: { query } as unknown as Pool,
      logger: mockLogger(),
      retentionDays: 30,
    });
    expect(await sweep.sweepOnce()).toBe(0);
  });

  it('swallows a sweep error (best-effort) — a failed sweep must not crash the service', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection reset'));
    const logger = mockLogger();
    const sweep = new ConsumedEventsRetention({
      pool: { query } as unknown as Pool,
      logger,
      retentionDays: 30,
    });
    await expect(sweep.sweepOnce()).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('tolerates a non-Error throw (e.g. a string) without crashing', async () => {
    const query = vi.fn().mockRejectedValue('boom-as-string');
    const logger = mockLogger();
    const sweep = new ConsumedEventsRetention({
      pool: { query } as unknown as Pool,
      logger,
      retentionDays: 30,
    });
    await expect(sweep.sweepOnce()).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects a non-positive retentionDays (a 0/negative TTL would delete live dedup rows)', () => {
    expect(
      () => new ConsumedEventsRetention({ pool: stubPool().pool, logger: mockLogger(), retentionDays: 0 }),
    ).toThrow(/retention/i);
    expect(
      () => new ConsumedEventsRetention({ pool: stubPool().pool, logger: mockLogger(), retentionDays: -1 }),
    ).toThrow(/retention/i);
  });
});

describe('ConsumedEventsRetention start/stop', () => {
  it('sweeps immediately on start, then on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    const { pool, query } = stubPool(1);
    const sweep = new ConsumedEventsRetention({
      pool,
      logger: mockLogger(),
      retentionDays: 30,
      intervalMs: 1000,
    });

    sweep.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(3);

    sweep.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(query).toHaveBeenCalledTimes(3); // no further sweeps after stop
  });

  it('start() is idempotent (a second start does not double-schedule)', async () => {
    vi.useFakeTimers();
    const { pool, query } = stubPool(0);
    const sweep = new ConsumedEventsRetention({
      pool, logger: mockLogger(), retentionDays: 30, intervalMs: 1000,
    });
    sweep.start();
    sweep.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    // 1 immediate + 1 interval = 2, NOT 4 (would be 4 if double-scheduled).
    expect(query).toHaveBeenCalledTimes(2);
    sweep.stop();
  });
});
