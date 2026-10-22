/** Exercises real outbox/consumer wiring in an explicitly selected nonzero synthetic slot. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { connect } from 'amqplib';

const slot = Number(process.argv[2]);
assert.ok(
  Number.isInteger(slot) && slot >= 1 && slot <= 9,
  'Usage: node scripts/check-event-stats.mjs <slot 1..9>'
);
const origin = `http://127.0.0.1:${8930 + slot * 1000}`;
const json = async path => {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
};
assert.deepEqual(await json('/api/health'), { ok: true, mode: 'live', slot });
const baseline = await json('/api/event-stats');
assert.deepEqual(baseline.scope, {
  environment: 'synthetic',
  deployment: `slot-${slot}`,
  broker: `soa-s${slot}`,
  vhost: '/',
});
const source = (snapshot, name) => {
  const matches = snapshot.sources.filter(
    s => s.report.identity.service === name && s.freshness === 'fresh'
  );
  assert.equal(matches.length, 1, `${name}: require exactly one fresh instance`);
  return matches[0].report;
};
for (const name of ['iam-api', 'programs-api', 'scheduling-api']) source(baseline, name);
const eventType = 'programs.program.created';
const stream = (snapshot, service, role) =>
  source(snapshot, service).streams.find(
    s => s.stream.role === role && s.stream.eventType === eventType
  );
const delta = (snapshot, service, role, counter) => {
  assert.equal(
    source(snapshot, service).epoch,
    source(baseline, service).epoch,
    'Service restarted during check'
  );
  return (
    (stream(snapshot, service, role)?.counters[counter] ?? 0) -
    (stream(baseline, service, role)?.counters[counter] ?? 0)
  );
};
const db = name =>
  new Pool({
    connectionString: `postgres://saga_user:password123@127.0.0.1:${5432 + slot * 1000}/${name}`,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
const programs = db('programs');
const scheduling = db('scheduling');
const makeEvent = () => {
  const id = randomUUID();
  const occurredAt = new Date().toISOString();
  return {
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    aggregateType: 'program',
    aggregateId: id,
    occurredAt,
    payload: {
      id,
      organizationId: randomUUID(),
      name: 'Telemetry synthetic check',
      createdBy: 'telemetry-check',
      createdAt: occurredAt,
    },
  };
};
const good = makeEvent();
const failed = makeEvent();
const suffix = failed.aggregateId.replaceAll('-', '');
const trigger = `telemetry_check_${suffix}`; // generated UUID only; never user SQL
let connection;
let triggerInstalled = false;
const until = async (description, fn) => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(500);
  }
  throw new Error(`Timed out: ${description}`);
};
const insert = event =>
  programs.query(
    `INSERT INTO outbox_event
  (event_id,aggregate_type,aggregate_id,event_type,event_version,payload,occurred_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      event.eventId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.eventVersion,
      event.payload,
      event.occurredAt,
    ]
  );
try {
  // Fail only this run's random program ID; existing rows and other traffic are unaffected.
  await scheduling.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id = '${failed.aggregateId}'::uuid THEN RAISE EXCEPTION 'synthetic telemetry handler failure'; END IF; RETURN NEW; END $$`);
  await scheduling.query(
    `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON program_projection FOR EACH ROW EXECUTE FUNCTION ${trigger}()`
  );
  triggerInstalled = true;
  await insert(good);
  await until(
    'successful projection committed',
    async () =>
      (await scheduling.query('SELECT 1 FROM program_projection WHERE id=$1', [good.aggregateId]))
        .rowCount === 1
  );
  connection = await connect(`amqp://rabbitmq_admin:password123@127.0.0.1:${5672 + slot * 1000}`, {
    timeout: 3000,
  });
  connection.on('error', () => {});
  const channel = await connection.createConfirmChannel();
  channel.publish('programs.events', eventType, Buffer.from(JSON.stringify(good)), {
    persistent: true,
    contentType: 'application/json',
  });
  await channel.waitForConfirms();
  await insert(failed);
  const after = await until(
    'reports include two publications, duplicate and failed handler',
    async () => {
      const s = await json('/api/event-stats');
      return (
        delta(s, 'programs-api', 'producer', 'publishAccepted') >= 2 &&
        delta(s, 'programs-api', 'consumer', 'commits') >= 2 &&
        delta(s, 'programs-api', 'consumer', 'duplicates') >= 1 &&
        delta(s, 'scheduling-api', 'consumer', 'duplicates') >= 1 &&
        delta(s, 'scheduling-api', 'consumer', 'processingFailures') >= 1 &&
        s
      );
    }
  );
  const expected = {
    programsProducer: { publishAttempts: 2, publishAccepted: 2, publishFailures: 0 },
    programsConsumer: {
      deliveries: 3,
      commits: 2,
      duplicates: 1,
      processingFailures: 0,
      ackIssued: 3,
    },
    schedulingConsumer: {
      deliveries: 3,
      commits: 1,
      duplicates: 1,
      processingFailures: 1,
      ackIssued: 2,
      nackIssued: 1,
    },
  };
  const actual = {};
  for (const [label, service, role] of [
    ['programsProducer', 'programs-api', 'producer'],
    ['programsConsumer', 'programs-api', 'consumer'],
    ['schedulingConsumer', 'scheduling-api', 'consumer'],
  ]) {
    actual[label] = Object.fromEntries(
      Object.keys(expected[label]).map(k => [k, delta(after, service, role, k)])
    );
    assert.deepEqual(
      actual[label],
      expected[label],
      `${label}: concurrent same-type traffic can invalidate this check`
    );
  }
  assert.equal(stream(after, 'programs-api', 'producer').counters.publishConfirmed, null);
  const eventIds = [good.eventId, failed.eventId];
  const published = (
    await programs.query(
      'SELECT event_id FROM outbox_event WHERE event_id=ANY($1::uuid[]) AND published_at IS NOT NULL',
      [eventIds]
    )
  ).rowCount;
  const committed = (
    await scheduling.query(
      'SELECT event_id FROM consumed_events WHERE consumer_name=$1 AND event_id=ANY($2::uuid[])',
      ['scheduling-api.programs-projection', eventIds]
    )
  ).rows;
  assert.equal(published, 2);
  assert.deepEqual(
    committed.map(r => r.event_id),
    [good.eventId]
  );
  assert.equal(
    (await scheduling.query('SELECT 1 FROM program_projection WHERE id=$1', [failed.aggregateId]))
      .rowCount,
    0
  );
  console.log(
    JSON.stringify(
      {
        slot,
        scope: after.scope,
        checkedAt: new Date().toISOString(),
        eventIds,
        actual,
        publishedOutboxRows: published,
        schedulingCommittedEventIds: committed.map(r => r.event_id),
        handlerFailureDelta:
          stream(after, 'scheduling-api', 'consumer').failureReasons.handler -
          (stream(baseline, 'scheduling-api', 'consumer')?.failureReasons.handler ?? 0),
        publishConfirmed: null,
      },
      null,
      2
    )
  );
} finally {
  if (triggerInstalled)
    await scheduling.query(`DROP TRIGGER IF EXISTS ${trigger} ON program_projection`);
  await scheduling.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  await connection?.close().catch(() => {});
  await Promise.all([programs.end(), scheduling.end()]);
}
