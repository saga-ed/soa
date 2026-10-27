import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryExportCursorStore,
  LAKE_EXPORT_STATE_DDL,
  PgExportCursorStore,
  collectOutboxAggregateIds,
  deterministicRunId,
  hourBucket,
  hourLockKey,
  runIncrementalExport,
  tryAcquireAdvisoryLock,
  type PgPoolLike,
  type SqlLike,
} from '../job/index.js';

function fakePool(locked: boolean) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (text: string, _values?: unknown[]) => {
      calls.push(text.includes('unlock') ? 'unlock' : 'lock');
      return { rows: [{ locked }] };
    }),
    release: vi.fn(() => {
      calls.push('release');
    }),
  };
  const pool: PgPoolLike = { connect: async () => client as never };
  return { pool, client, calls };
}

function fakeSql(rows: unknown[] = []) {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows }));
  return { sql: { query } as unknown as SqlLike, query };
}

describe('tryAcquireAdvisoryLock', () => {
  it('returns acquired and unlocks before releasing the client', async () => {
    const { pool, client, calls } = fakePool(true);
    const lock = await tryAcquireAdvisoryLock(pool, 7, 9);
    expect(lock.acquired).toBe(true);
    expect(client.query.mock.calls[0]?.[1]).toEqual([7, 9]);
    if (lock.acquired) await lock.release();
    expect(calls).toEqual(['lock', 'unlock', 'release']);
  });

  it('releases the client immediately when not acquired', async () => {
    const { pool, calls } = fakePool(false);
    const lock = await tryAcquireAdvisoryLock(pool, 7, 9);
    expect(lock).toEqual({ acquired: false });
    expect(calls).toEqual(['lock', 'release']);
  });

  it('hourLockKey is stable within an hour and changes across hours', () => {
    const a = hourLockKey(new Date('2026-10-27T14:01:00Z'));
    expect(hourLockKey(new Date('2026-10-27T14:59:00Z'))).toBe(a);
    expect(hourLockKey(new Date('2026-10-27T15:00:00Z'))).toBe(a + 1);
  });
});

describe('deterministicRunId', () => {
  it('is a stable UUID within an hour and differs across hours and labels', () => {
    const a = deterministicRunId('job', new Date('2026-10-27T14:05:00Z'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicRunId('job', new Date('2026-10-27T14:55:00Z'))).toBe(a);
    expect(deterministicRunId('job', new Date('2026-10-27T15:05:00Z'))).not.toBe(a);
    expect(deterministicRunId('other', new Date('2026-10-27T14:05:00Z'))).not.toBe(a);
    expect(hourBucket(new Date('2026-10-27T14:05:00Z'))).toBe('2026-10-27T14');
  });
});

describe('PgExportCursorStore', () => {
  it('upserts by job', async () => {
    const { sql, query } = fakeSql();
    const store = new PgExportCursorStore(sql);
    const watermark = new Date('2026-10-27T14:00:00Z');
    await store.write('j', { watermark, runId: 'r' });
    const [text, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toContain('INSERT INTO lake_export_state');
    expect(text).toContain('ON CONFLICT (job) DO UPDATE');
    expect(values).toEqual(['j', watermark, 'r']);
  });

  it('reads null when absent and maps a row when present', async () => {
    expect(await new PgExportCursorStore(fakeSql([]).sql).read('j')).toBeNull();
    const row = {
      watermark: '2026-10-27T14:00:00Z',
      run_id: 'r',
      updated_at: '2026-10-27T14:01:00Z',
    };
    const cursor = await new PgExportCursorStore(fakeSql([row]).sql).read('j');
    expect(cursor).toEqual({
      watermark: new Date(row.watermark),
      runId: 'r',
      updatedAt: new Date(row.updated_at),
    });
  });

  it('rejects an invalid table name and exposes the DDL', () => {
    expect(() => new PgExportCursorStore(fakeSql().sql, 'x;drop')).toThrow();
    expect(LAKE_EXPORT_STATE_DDL).toContain('CREATE TABLE IF NOT EXISTS lake_export_state');
  });
});

describe('collectOutboxAggregateIds', () => {
  it('queries outbox and archive with since/until/types and returns ids', async () => {
    const { sql, query } = fakeSql([{ aggregate_id: 'a' }, { aggregate_id: 'b' }]);
    const since = new Date('2026-10-27T13:00:00Z');
    const until = new Date('2026-10-27T14:00:00Z');
    const ids = await collectOutboxAggregateIds({ sql, since, until, aggregateTypes: ['session'] });
    expect(ids).toEqual(['a', 'b']);
    const [text, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toContain('FROM outbox_event WHERE');
    expect(text).toContain('FROM outbox_event_archive WHERE');
    expect(text).toContain('UNION ALL');
    expect(text).toContain('aggregate_type = ANY($3)');
    expect(values).toEqual([since, until, ['session']]);
  });

  it('rejects unsafe identifiers', async () => {
    const base = { sql: fakeSql().sql, since: new Date(), until: new Date(), aggregateTypes: [] };
    await expect(collectOutboxAggregateIds({ ...base, table: 'foo;drop' })).rejects.toThrow(
      /invalid/,
    );
    await expect(
      collectOutboxAggregateIds({
        ...base,
        columns: { aggregateType: 'a', aggregateId: 'b c', occurredAt: 'c' },
      }),
    ).rejects.toThrow(/invalid/);
  });
});

describe('runIncrementalExport', () => {
  const now = new Date('2026-10-27T14:00:00Z');
  const min = 60_000;
  const build = (initialSince = new Date('2026-10-27T12:00:00Z')) => {
    const cursorStore = new InMemoryExportCursorStore();
    const collectKeys = vi.fn(async () => ['k1']);
    const exportKeys = vi.fn(async () => undefined);
    return {
      cursorStore,
      collectKeys,
      exportKeys,
      run: (at: Date = now) =>
        runIncrementalExport<string>({
          job: 'j',
          cursorStore,
          now: at,
          initialSince,
          collectKeys,
          exportKeys,
        }),
    };
  };

  it('first run uses initialSince minus overlap; second uses watermark minus overlap', async () => {
    const t = build();
    const first = await t.run();
    expect(first.window.since).toEqual(new Date(Date.parse('2026-10-27T12:00:00Z') - 10 * min));
    expect(first.window.until).toEqual(new Date(now.getTime() - 10 * min));
    expect(first.cursorAfter?.watermark).toEqual(first.window.until);

    const second = await t.run(new Date('2026-10-27T15:00:00Z'));
    expect(second.window.since).toEqual(new Date(first.window.until.getTime() - 10 * min));
    expect(second.cursorBefore?.watermark).toEqual(first.window.until);
  });

  it('skips without writing when until <= since', async () => {
    const t = build(new Date(now.getTime()));
    const res = await t.run();
    expect(res.skipped).toBe(true);
    expect(t.collectKeys).not.toHaveBeenCalled();
    expect(await t.cursorStore.read('j')).toBeNull();
  });

  it('does not write the cursor when exportKeys throws', async () => {
    const t = build();
    t.exportKeys.mockRejectedValueOnce(new Error('boom'));
    await expect(t.run()).rejects.toThrow('boom');
    expect(await t.cursorStore.read('j')).toBeNull();
  });

  it('writes the cursor with until when keys are empty and skips export', async () => {
    const t = build();
    t.collectKeys.mockResolvedValueOnce([]);
    const res = await t.run();
    expect(t.exportKeys).not.toHaveBeenCalled();
    expect(res.keyCount).toBe(0);
    expect((await t.cursorStore.read('j'))?.watermark).toEqual(res.window.until);
  });
});
