import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OutboxRelay, type OutboxRelayOpts } from '../relay.js';

function fixture(
  options: {
    commitFails?: boolean;
    publishFails?: boolean;
    observerThrows?: boolean;
    metricsThrow?: boolean;
  } = {}
) {
  const observations: Array<{ kind: string }> = [];
  const row = {
    event_id: 'test-id',
    event_type: 'test.created',
    event_version: 1,
    aggregate_type: 'test',
    aggregate_id: 'one',
    occurred_at: new Date(),
    payload: {},
    meta: null,
    attempts: 0,
  };
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === 'COMMIT' && options.commitFails) throw new Error('commit failed');
      return { rows: sql.includes('SELECT event_id') ? [row] : [] };
    }),
    release: vi.fn(),
  });
  const channel = Object.assign(new EventEmitter(), {
    publish: vi.fn(() => {
      if (options.publishFails) throw new Error('transport failed');
      return true;
    }),
  });
  const relay = new OutboxRelay({
    pool: { connect: async () => client } as unknown as OutboxRelayOpts['pool'],
    connectionManager: {} as OutboxRelayOpts['connectionManager'],
    exchange: 'test.events',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: {
      onPublished: () => {
        if (options.metricsThrow) throw new Error('metrics broken');
      },
      onPublishFailed: vi.fn(),
    },
    observe: o => {
      observations.push(o);
      if (options.observerThrows) throw new Error('observer failed');
    },
  });
  (relay as unknown as { channel: unknown }).channel = channel;
  return {
    observations,
    client,
    drain: () => (relay as unknown as { drainBatch(): Promise<void> }).drainBatch(),
  };
}

describe('outbox observations (I#535)', () => {
  it('reports client acceptance without inventing broker confirmation', async () => {
    const f = fixture();
    await f.drain();
    expect(f.observations.map(o => o.kind)).toEqual(['attempted', 'accepted']);
  });
  it('retains transport acceptance when the outbox transaction subsequently fails', async () => {
    const f = fixture({ commitFails: true });
    await expect(f.drain()).rejects.toThrow('commit failed');
    expect(f.observations.map(o => o.kind)).toEqual(['attempted', 'accepted']);
    expect(f.client.query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('reports failed attempts separately', async () => {
    const f = fixture({ publishFails: true });
    await expect(f.drain()).rejects.toThrow('transport failed');
    expect(f.observations.map(o => o.kind)).toEqual(['attempted', 'failed']);
  });
  it('isolates legacy metric failures from transport outcomes', async () => {
    const f = fixture({ metricsThrow: true });
    await expect(f.drain()).resolves.toBeUndefined();
    expect(f.observations.map(o => o.kind)).toEqual(['attempted', 'accepted']);
  });
  it('does not roll back business publishing when the observer throws', async () => {
    const f = fixture({ observerThrows: true });
    await expect(f.drain()).resolves.toBeUndefined();
    expect(f.client.query).not.toHaveBeenCalledWith('ROLLBACK');
  });
});
