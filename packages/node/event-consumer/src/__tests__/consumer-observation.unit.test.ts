import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Channel, ConsumeMessage } from 'amqplib';
import { EventConsumer, type EventConsumerOpts } from '../consumer.js';

// I#535: observe business boundaries without changing transaction or settlement behavior.
function fixture(
  options: {
    duplicate?: boolean;
    commitFails?: boolean;
    handlerFails?: boolean;
    ackFails?: boolean;
    observerThrows?: boolean;
    metricsThrow?: boolean;
  } = {}
) {
  const observations: Array<{ kind: string; reason?: string }> = [];
  const query = vi.fn(async (sql: string) => {
    if (sql === 'COMMIT' && options.commitFails) throw new Error('db unavailable');
    return { rows: [], rowCount: options.duplicate ? 0 : 1 };
  });
  const handler = vi.fn(async () => {
    if (options.handlerFails) throw new Error('private business detail');
  });
  const channel = {
    ack: vi.fn(() => {
      if (options.ackFails) throw new Error('closed');
    }),
    nack: vi.fn(),
  };
  const consumer = new EventConsumer({
    consumerName: 'test.projection',
    queue: 'test.projection',
    bindings: [],
    pool: {
      connect: async () => ({ query, release: vi.fn() }),
    } as unknown as EventConsumerOpts['pool'],
    connectionManager: {} as EventConsumerOpts['connectionManager'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: {
      onProcessed: () => {
        if (options.metricsThrow) throw new Error('metrics broken');
      },
      onFailed: vi.fn(),
      onDuplicate: () => {
        if (options.metricsThrow) throw new Error('metrics broken');
      },
    },
    handlers: [
      { eventType: 'test.created', eventVersion: 1, payloadSchema: z.object({}), handle: handler },
    ],
    observe: o => {
      observations.push(o);
      if (options.observerThrows) throw new Error('observer broken');
    },
  });
  const envelope = {
    eventId: '00000000-0000-4000-8000-000000000001',
    eventType: 'test.created',
    eventVersion: 1,
    aggregateType: 'test',
    aggregateId: 'one',
    occurredAt: new Date().toISOString(),
    payload: {},
  };
  const deliver = (body: unknown = envelope, routingKey = 'test.created') =>
    (consumer as unknown as { dispatch(ch: Channel, msg: ConsumeMessage): Promise<void> }).dispatch(
      channel as unknown as Channel,
      {
        content: Buffer.from(JSON.stringify(body)),
        fields: { exchange: 'test.events', routingKey, redelivered: false },
      } as ConsumeMessage
    );
  return { observations, query, handler, channel, deliver, consumer, envelope };
}

describe('consumer observations (I#535)', () => {
  it('separates committed work from delivery and acknowledgement', async () => {
    const f = fixture();
    await f.deliver();
    expect(f.observations.map(o => o.kind)).toEqual(['delivered', 'committed', 'ackIssued']);
  });
  it('counts duplicates without counting new committed work', async () => {
    const f = fixture({ duplicate: true });
    await f.deliver();
    expect(f.observations.map(o => o.kind)).toEqual(['delivered', 'duplicate', 'ackIssued']);
    expect(f.handler).not.toHaveBeenCalled();
  });
  it.each(['commitFails', 'handlerFails'] as const)(
    'does not count committed work on %s',
    async failure => {
      const f = fixture({ [failure]: true });
      await f.deliver();
      expect(f.observations.map(o => o.kind)).toEqual(['delivered', 'failed', 'nackIssued']);
      expect(f.query).toHaveBeenCalledWith('ROLLBACK');
      expect(JSON.stringify(f.observations)).not.toContain('private business detail');
    }
  );
  it('retains committed work when acknowledgement fails', async () => {
    const f = fixture({ ackFails: true });
    await f.deliver();
    expect(f.observations.map(o => o.kind)).toEqual(['delivered', 'committed', 'ackFailed']);
    expect(f.channel.nack).not.toHaveBeenCalled();
  });
  it('isolates observer exceptions from commits and acknowledgements', async () => {
    const f = fixture({ observerThrows: true });
    await f.deliver();
    expect(f.channel.ack).toHaveBeenCalledOnce();
    expect(f.channel.nack).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalledWith('ROLLBACK');
  });
  it.each([false, true])('isolates legacy metric failures (duplicate=%s)', async duplicate => {
    const f = fixture({ metricsThrow: true, duplicate });
    await f.deliver();
    expect(f.channel.ack).toHaveBeenCalledOnce();
    expect(f.channel.nack).not.toHaveBeenCalled();
    expect(f.observations.map(o => o.kind)).toEqual([
      'delivered',
      duplicate ? 'duplicate' : 'committed',
      'ackIssued',
    ]);
  });
  it('counts malformed deliveries with a bounded failure reason', async () => {
    const f = fixture();
    await f.deliver({ secret: 'not an envelope' });
    expect(f.observations.map(o => o.kind)).toEqual(['delivered', 'failed', 'nackIssued']);
    expect(f.observations[1]?.reason).toBe('envelope');
    expect(f.channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });
  it('excludes telemetry even if a broad binding delivers it', async () => {
    const f = fixture();
    await f.deliver(
      { ...f.envelope, eventType: 'observability.event_stats.reported' },
      'observability.event_stats.reported'
    );
    expect(f.observations).toEqual([]);
  });
});
