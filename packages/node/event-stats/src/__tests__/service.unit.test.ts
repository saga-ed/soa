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
