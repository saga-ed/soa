import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { connect, type ChannelModel } from 'amqplib';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import { EventStats, REPORT_EVENT_TYPE } from '@saga-ed/soa-event-stats';
import { buildEnvelope } from '@saga-ed/soa-event-envelope';
import { EventStatsStore, REPORTERS } from './event-stats-store';
import { EventStatsReceiver } from './event-stats-receiver';

let infra: InfraHandle;
let pool: Pool;
let connection: ChannelModel;
const scope = { environment: 'synthetic', deployment: 'slot-3', broker: 'soa-s3', vhost: '/' };
const identity = { ...scope, service: 'iam-api', revision: 'test', instance: 'one' };
const producer = (instance = 'one') =>
  new EventStats({ identity: { ...identity, instance }, capabilities: ['producer'] });
const stream = {
  role: 'producer' as const,
  exchange: 'iam.events',
  eventType: 'iam.user.created',
  eventVersion: 1,
};
const store = () => new EventStatsStore(pool, scope);
beforeAll(async () => {
  infra = await startInfra();
  pool = new Pool({ connectionString: infra.postgresAdminUrl });
  connection = await connect(infra.rabbitmqUrl);
  await store().init();
});
beforeEach(async () => {
  await pool.query('TRUNCATE event_stats_source');
});
afterAll(async () => {
  await connection?.close();
  await pool?.end();
  await infra?.stop();
});
it('persists monotonic baselines across receiver restart, missed and out-of-order reports', async () => {
  let time = 0;
  const stats = new EventStats({
    identity,
    capabilities: ['producer'],
    monotonicClock: () => time,
  });
  const recorder = stats.register(stream);
  const first = stats.snapshot();
  expect(await store().apply(first, 'iam.events')).toBe('accepted');
  recorder.increment('publishAccepted');
  time = 1000;
  stats.snapshot();
  recorder.increment('publishAccepted');
  time = 2000;
  const last = stats.snapshot();
  expect(await store().apply(last, 'iam.events')).toBe('accepted');
  expect(await store().apply(first, 'iam.events')).toBe('ignored');
  expect(await store().apply(last, 'iam.events')).toBe('ignored');
  const view = await store().read();
  expect(view.sources[0]?.comparison?.streams[0]?.rates.publishAccepted).toBe(1);
});
it('rejects a retired process epoch after restart and keeps replicas separate', async () => {
  const old = producer().snapshot();
  await store().apply(old, 'iam.events');
  const next = producer().snapshot();
  await store().apply(next, 'iam.events');
  expect(await store().apply({ ...old, sequence: 999 }, 'iam.events')).toBe('ignored');
  await store().apply(producer('two').snapshot(), 'iam.events');
  const view = await store().read();
  expect(view.sources).toHaveLength(2);
  expect(view.sources.every(s => s.comparison?.status === 'baseline')).toBe(true);
});
it('rejects environment and exchange impersonation without retaining them', async () => {
  const report = producer().snapshot();
  expect(
    await store().apply(
      { ...report, identity: { ...report.identity, deployment: 'slot-0' } },
      'iam.events'
    )
  ).toBe('scope');
  expect(await store().apply(report, 'programs.events')).toBe('scope');
  expect((await store().read()).sources).toHaveLength(0);
});
it('bounds sources and epoch tombstones, and distinguishes stale from zero', async () => {
  const limited = new EventStatsStore(pool, scope, {
    sources: 1,
    epochs: 1,
    retentionMs: 10000,
    staleMs: 1000,
  });
  const t = new Date();
  const first = producer().snapshot();
  await limited.apply(first, 'iam.events', t);
  expect(await limited.apply(producer('two').snapshot(), 'iam.events', t)).toBe('capacity');
  await limited.apply(producer().snapshot(), 'iam.events', t);
  expect(await limited.apply(producer().snapshot(), 'iam.events', t)).toBe('capacity');
  const stale = await limited.read(new Date(t.getTime() + 2000));
  expect(stale.sources[0]?.freshness).toBe('stale');
  expect(stale.sources[0]?.comparison).toBeNull();
  expect((await limited.read(new Date(t.getTime() + 10001))).sources).toHaveLength(0);
});
it('dead-letters malformed reports and recovers an unacked report after storage failure', async () => {
  const channel = await connection.createChannel();
  for (const exchange of Object.values(REPORTERS))
    await channel.assertExchange(exchange, 'topic', { durable: true });
  const persistent = store();
  const apply = vi.spyOn(persistent, 'apply');
  apply.mockRejectedValueOnce(new Error('database offline'));
  const receiver = new EventStatsReceiver({
    url: infra.rabbitmqUrl,
    queue: 'vishnu.test.stats',
    store: persistent,
    onError: vi.fn(),
  });
  try {
    receiver.start();
    await vi.waitFor(() => expect(receiver.status().connected).toBe(true), { timeout: 10000 });
    channel.publish('iam.events', REPORT_EVENT_TYPE, Buffer.from('{}'));
    const payload = producer().snapshot();
    const event = buildEnvelope({
      eventType: REPORT_EVENT_TYPE,
      eventVersion: 1,
      aggregateType: 'stats',
      aggregateId: payload.epoch,
      payload,
    });
    channel.publish('iam.events', REPORT_EVENT_TYPE, Buffer.from(JSON.stringify(event)));
    await vi.waitFor(async () => expect((await persistent.read()).sources).toHaveLength(1), {
      timeout: 10000,
    });
    expect(receiver.status().storageFailures).toBe(1);
    expect(receiver.status().accepted).toBe(1);
    expect((await channel.checkQueue('vishnu.test.stats.invalid')).messageCount).toBe(1);
    await receiver.stop();
    const restarted = store();
    expect((await restarted.read()).sources).toHaveLength(1);
  } finally {
    await receiver.stop();
    await channel.close();
  }
});
