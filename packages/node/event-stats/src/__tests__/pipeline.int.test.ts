import { IsolatedRabbitMqReportTransport } from '../service.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import amqp, { type ChannelModel } from 'amqplib';
import { Pool } from 'pg';
import { z } from 'zod';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import { EventConsumer, CONSUMED_EVENTS_SQL } from '@saga-ed/soa-event-consumer';
import { OutboxRelay, OUTBOX_EVENT_SQL } from '@saga-ed/soa-event-outbox';
import { buildEnvelope } from '@saga-ed/soa-event-envelope';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import {
  compareReports,
  EventStats,
  EventStatsReporter,
  RabbitMqReportTransport,
  ReportSchema,
  REPORT_EVENT_TYPE,
} from '../index.js';

let infra: InfraHandle;
let pool: Pool;
let business: ChannelModel;
let reporting: ChannelModel;
let relay: OutboxRelay | undefined;
const consumers: EventConsumer[] = [];
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
const identity = {
  service: 'fixture',
  environment: 'test',
  deployment: 'test',
  revision: 'test',
  instance: 'publisher',
  broker: 'local',
  vhost: '/',
};
beforeAll(async () => {
  infra = await startInfra();
  pool = new Pool({ connectionString: infra.postgresAdminUrl });
  await pool.query(OUTBOX_EVENT_SQL);
  await pool.query(CONSUMED_EVENTS_SQL);
  await pool.query(
    'CREATE TABLE projection (consumer text, event_id uuid, PRIMARY KEY (consumer,event_id))'
  );
  business = await amqp.connect(infra.rabbitmqUrl);
  reporting = await amqp.connect(infra.rabbitmqUrl);
});
afterAll(async () => {
  await relay?.stop();
  await Promise.all(consumers.map(c => c.stop()));
  await reporting?.close();
  await business?.close();
  await pool?.end();
  await infra?.stop();
});
it('reconciles real fanout, duplicate and rollback evidence with independently transported reports (I#535)', async () => {
  const exchange = 'fixture.events';
  const channel = await business.createChannel();
  await channel.assertExchange(exchange, 'topic', { durable: true });
  const reports = (await channel.assertQueue('', { exclusive: true })).queue;
  await channel.bindQueue(reports, exchange, REPORT_EVENT_TYPE);
  const manager = {
    ensureConnected: async () => {},
    newChannel: () => business.createChannel(),
  } as unknown as ConnectionManager;
  const producer = new EventStats({ identity, capabilities: ['producer'] });
  const stats = ['one', 'two'].map(
    instance => new EventStats({ identity: { ...identity, instance }, capabilities: ['consumer'] })
  );
  for (let i = 0; i < stats.length; i++) {
    const name = `fixture-${i}`;
    const consumer = new EventConsumer({
      consumerName: name,
      queue: name,
      pool,
      connectionManager: manager,
      logger,
      bindings: [{ exchange, routingKey: 'fixture.created' }],
      dlq: { exchange: `${name}.dlx`, queue: `${name}.dlq` },
      observe: stats[i]!.observeConsumer,
      handlers: [
        {
          eventType: 'fixture.created',
          eventVersion: 1,
          payloadSchema: z.object({ fail: z.boolean() }),
          handle: async (envelope, payload, tx) => {
            await tx.query('INSERT INTO projection VALUES ($1,$2)', [name, envelope.eventId]);
            if ((payload as { fail: boolean }).fail) throw new Error('fixture rollback');
          },
        },
      ],
    });
    consumers.push(consumer);
    await consumer.start();
  }
  const envelope = buildEnvelope({
    eventType: 'fixture.created',
    eventVersion: 1,
    aggregateType: 'fixture',
    aggregateId: 'one',
    payload: { fail: false },
  });
  await pool.query(
    'INSERT INTO outbox_event (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      envelope.eventId,
      envelope.aggregateType,
      envelope.aggregateId,
      envelope.eventType,
      envelope.eventVersion,
      envelope.payload,
      envelope.occurredAt,
    ]
  );
  relay = new OutboxRelay({
    pool,
    connectionManager: manager,
    exchange,
    logger,
    observe: producer.observeOutbox,
    pollIntervalMs: 20,
  });
  await relay.start();
  await vi.waitFor(
    () => expect(stats.map(s => s.snapshot().streams[0]?.counters.commits)).toEqual([1, 1]),
    { timeout: 10_000 }
  );
  channel.publish(exchange, envelope.eventType, Buffer.from(JSON.stringify(envelope)));
  const failed = buildEnvelope({
    eventType: 'fixture.created',
    eventVersion: 1,
    aggregateType: 'fixture',
    aggregateId: 'two',
    payload: { fail: true },
  });
  channel.publish(exchange, failed.eventType, Buffer.from(JSON.stringify(failed)));
  await vi.waitFor(
    () => expect(stats.map(s => s.snapshot().streams[0]?.counters.nackIssued)).toEqual([1, 1]),
    { timeout: 10_000 }
  );
  expect((await pool.query('SELECT * FROM projection')).rowCount).toBe(2);
  expect((await pool.query('SELECT * FROM consumed_events')).rowCount).toBe(2);
  expect(
    (await pool.query('SELECT * FROM outbox_event WHERE published_at IS NOT NULL')).rowCount
  ).toBe(1);
  for (const s of stats) {
    expect(s.snapshot().streams[0]?.counters).toMatchObject({
      deliveries: 3,
      commits: 1,
      duplicates: 1,
      processingFailures: 1,
      ackIssued: 2,
      nackIssued: 1,
      requeues: 0,
    });
    expect(s.snapshot().streams[0]?.failureReasons.handler).toBe(1);
  }
  expect(producer.snapshot().streams[0]?.counters).toMatchObject({
    publishAttempts: 1,
    publishAccepted: 1,
    publishConfirmed: null,
  });
  for (const s of [producer, ...stats]) {
    const reporter = new EventStatsReporter({
      stats: s,
      transport: new IsolatedRabbitMqReportTransport(infra.rabbitmqUrl, exchange),
    });
    await reporter.flush();
    await reporter.stop();
  }
  const received = [];
  await vi.waitFor(
    async () => {
      let message;
      while ((message = await channel.get(reports, { noAck: true })))
        received.push(ReportSchema.parse(JSON.parse(message.content.toString()).payload));
      expect(received).toHaveLength(3);
    },
    { timeout: 10_000 }
  );
  expect(new Set(received.map(r => r.identity.instance)).size).toBe(3);
  expect(stats.map(s => s.snapshot().streams[0]?.counters.deliveries)).toEqual([3, 3]);
  for (let i = 0; i < 2; i++)
    expect((await channel.checkQueue(`fixture-${i}.dlq`)).messageCount).toBe(1);
  // An actual reporting connection loss leaves business connections and counters intact.
  const recovering = new EventStatsReporter({
    stats: producer,
    transport: new RabbitMqReportTransport({
      exchange,
      createChannel: () => reporting.createChannel(),
    }),
  });
  await reporting.close();
  await recovering.flush();
  expect(producer.snapshot().diagnostics.reportingFailures).toBe(1);
  expect((await pool.query('SELECT * FROM projection')).rowCount).toBe(2);
  reporting = await amqp.connect(infra.rabbitmqUrl);
  await recovering.flush();
  await recovering.stop();
  await vi.waitFor(
    async () => {
      const message = await channel.get(reports, { noAck: true });
      expect(message).not.toBe(false);
      if (!message) return;
      const recovered = ReportSchema.parse(JSON.parse(message.content.toString()).payload);
      const baseline = received.find(r => r.identity.instance === 'publisher');
      const comparison = compareReports(baseline, recovered);
      expect(comparison.status).toBe('advanced');
      expect(comparison.streams[0]?.deltas.publishAccepted).toBe(0);
      expect(recovered.diagnostics.reportingFailures).toBe(1);
    },
    { timeout: 10_000 }
  );
  await channel.close();
});
