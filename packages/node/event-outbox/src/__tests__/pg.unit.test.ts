import { describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
import { writeOutboxPg } from '../pg.js';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: '11111111-1111-1111-1111-111111111111',
    eventType: 'group.created',
    eventVersion: 1,
    aggregateType: 'group',
    aggregateId: 'grp_1',
    occurredAt: '2026-01-02T03:04:05.000Z',
    payload: { id: 'grp_1', kind: 'class' },
    ...overrides,
  } as EventEnvelope;
}

describe('writeOutboxPg', () => {
  it('issues a single parameterized INSERT into outbox_event with the canonical columns + casts', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await writeOutboxPg({ query }, envelope());

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/insert\s+into\s+outbox_event/i);
    // Column order + casts must stay shape-equivalent to writeOutbox's INSERT.
    expect(sql).toContain('$1::uuid');
    expect(sql).toContain('$6::jsonb');
    expect(sql).toContain('$7::jsonb');
    expect(sql).toContain('$8::timestamptz');
    expect(params).toEqual([
      '11111111-1111-1111-1111-111111111111',
      'group',
      'grp_1',
      'group.created',
      1,
      JSON.stringify({ id: 'grp_1', kind: 'class' }),
      null,
      '2026-01-02T03:04:05.000Z',
    ]);
  });

  it('serializes meta to JSON when present', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await writeOutboxPg({ query }, envelope({ meta: { traceparent: 'tp-1' } as EventEnvelope['meta'] }));
    const [, params] = query.mock.calls[0];
    expect(params[6]).toBe(JSON.stringify({ traceparent: 'tp-1' }));
  });

  it('passes null for meta when absent (not the string "null")', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await writeOutboxPg({ query }, envelope({ meta: undefined }));
    const [, params] = query.mock.calls[0];
    expect(params[6]).toBeNull();
  });
});
