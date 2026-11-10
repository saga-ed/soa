import { expect, it, vi } from 'vitest';
import { createServiceEventStats } from '../service.js';
it('is disabled by default and does not require or open broker resources', async () => {
  const t = createServiceEventStats({
    service: 'test',
    capabilities: ['producer'],
    publisherExchange: 'test.events',
    env: {},
    onError: vi.fn(),
  });
  expect(t.enabled).toBe(false);
  t.start();
  await t.stop();
  expect(t.stats).toBeUndefined();
});
it('requires explicit scope when enabled', () => {
  expect(() =>
    createServiceEventStats({
      service: 'test',
      capabilities: ['producer'],
      publisherExchange: 'test.events',
      env: { EVENT_STATS_ENABLED: 'true' },
      onError: vi.fn(),
    })
  ).toThrow('EVENT_STATS_ENVIRONMENT');
});
it('registers exact idle streams using complete RabbitMQ topic semantics', () => {
  const telemetry = createServiceEventStats({
    service: 'test',
    capabilities: ['consumer'],
    publisherExchange: 'test.events',
    onError: vi.fn(),
    env: {
      EVENT_STATS_ENABLED: 'true',
      EVENT_STATS_ENVIRONMENT: 'synthetic',
      EVENT_STATS_DEPLOYMENT: 'slot-3',
      EVENT_STATS_REVISION: 'test',
      EVENT_STATS_BROKER: 'soa-s3',
      EVENT_STATS_VHOST: '/',
      RABBITMQ_URL: 'amqp://localhost',
    },
  });
  const config = {
    queue: 'test',
    consumerName: 'test',
    bindings: [{ exchange: 'test.events', routingKey: 'a.#.z' }],
    handlers: ['a.z', 'a.b.c.z', 'a.b.other'].map(eventType => ({
      eventType,
      eventVersion: 1,
      payloadSchema: { parse: (x: unknown) => x },
      handle: async () => {},
    })),
  };
  telemetry.consumer(config as Parameters<typeof telemetry.consumer>[0]);
  expect(telemetry.stats!.snapshot().streams.map(s => s.stream.eventType)).toEqual([
    'a.z',
    'a.b.c.z',
  ]);
});
