import { expect, it } from 'vitest';
import { EventStats, compareReports } from '@saga-ed/soa-event-stats';
import { scopedStats, serviceStats, type StatsSnapshot, type StatsSource } from './event-stats';
const now = new Date().toISOString();
const scope = { environment: 'synthetic', deployment: 'slot-3', broker: 'soa-s3', vhost: '/' };
function source(instance = 'one', accepted = 3, interval = 1000): StatsSource {
  let time = 0;
  const stats = new EventStats({
    identity: { ...scope, service: 'programs-api', revision: 'a', instance },
    capabilities: ['producer'],
    monotonicClock: () => time,
  });
  const stream = stats.register({
    role: 'producer',
    exchange: 'programs.events',
    eventType: 'programs.program.created',
    eventVersion: 1,
  });
  const baseline = stats.snapshot();
  for (let i = 0; i < accepted; i++) stream.increment('publishAccepted');
  time = interval;
  const report = stats.snapshot();
  return {
    report,
    receivedAt: now,
    freshness: 'fresh',
    comparison: compareReports(baseline, report),
  };
}
const snapshot = (sources: StatsSource[]): StatsSnapshot => ({
  version: 1,
  scope,
  observedAt: now,
  staleAfterMs: 90000,
  sources,
  receiver: { connected: true },
});
const metric = (view: ReturnType<typeof serviceStats>, key = 'publishAccepted') =>
  view.rows.find(r => r.key === key)!;
it('sums fresh replicas, deduplicates repeated snapshots and excludes stale instances', () => {
  const a = source(),
    b = source('two', 4, 2000),
    old = { ...source('old', 99), freshness: 'stale' as const };
  const view = serviceStats(snapshot([a, a, b, old]), 'programs-api');
  expect(metric(view)).toMatchObject({ count: 7, rate: 5 });
  expect(view.fresh).toHaveLength(2);
  expect(view.stale).toBe(1);
});
it('distinguishes measured zero, unsupported, baseline and no reports', () => {
  const zero = source('one', 0);
  expect(metric(serviceStats(snapshot([zero]), 'programs-api'))).toMatchObject({
    count: 0,
    rate: 0,
  });
  expect(
    metric(serviceStats(snapshot([zero]), 'programs-api'), 'publishConfirmed').count
  ).toBeNull();
  const initial = { ...zero, comparison: compareReports(undefined, zero.report) };
  expect(metric(serviceStats(snapshot([initial]), 'programs-api')).rate).toBeNull();
  expect(serviceStats(snapshot([]), 'sessions-api').status).toBe('No reports');
});
it('ages reports and marks cached counters unavailable on API failure', () => {
  const data = snapshot([source()]);
  expect(serviceStats(data, 'programs-api', 90001).status).toBe('Stale');
  expect(metric(serviceStats(data, 'programs-api', 0, true)).count).toBeNull();
  expect(serviceStats(data, 'programs-api', 0, true).status).toBe('Unavailable');
});
it('rejects a report from another slot', () => {
  const other = source();
  other.report.identity.deployment = 'slot-0';
  expect(serviceStats(snapshot([other]), 'programs-api').sources).toHaveLength(0);
});
it('keeps consumer deliveries, commits and duplicate skips distinct across subscriptions', () => {
  const stats = new EventStats({
    identity: { ...scope, service: 'programs-api', revision: 'a', instance: 'one' },
    capabilities: ['consumer'],
  });
  for (const consumer of ['projection', 'reconcile']) {
    const stream = stats.register({
      role: 'consumer',
      exchange: 'programs.events',
      queue: consumer,
      consumer,
      eventType: 'programs.program.created',
      eventVersion: 1,
    });
    stream.increment('deliveries');
    stream.increment('deliveries');
    stream.increment('commits');
    stream.increment('duplicates');
  }
  const report = stats.snapshot();
  const view = serviceStats(
    snapshot([{ report, receivedAt: now, freshness: 'fresh', comparison: null }]),
    'programs-api'
  );
  expect(metric(view, 'deliveries').count).toBe(4);
  expect(metric(view, 'commits').count).toBe(2);
  expect(metric(view, 'duplicates').count).toBe(2);
});
it('accepts stats only for the exact synthetic slot or hosted MQ deployment', () => {
  const stats = (scope: StatsSnapshot['scope']): StatsSnapshot => ({
    version: 1,
    scope,
    observedAt: now,
    staleAfterMs: 90000,
    sources: [],
    receiver: { connected: true },
  });
  const hostedScope = {
    environment: 'dev',
    deployment: 'main',
    broker: 'shared-dev-mq',
    vhost: '/',
  };
  const hosted = { environment: 'dev', deployment: 'main' };
  expect(scopedStats(stats(scope), { mode: 'live', slot: 3 }, null)).not.toBeNull();
  expect(scopedStats(stats(scope), { mode: 'live', slot: 4 }, null)).toBeNull();
  expect(scopedStats(stats(hostedScope), { mode: 'live' }, hosted)).not.toBeNull();
  expect(scopedStats(stats(hostedScope), { mode: 'live' }, null)).toBeNull();
  expect(
    scopedStats(stats({ ...hostedScope, deployment: 'blue' }), { mode: 'live' }, hosted)
  ).toBeNull();
  expect(
    scopedStats(stats({ ...hostedScope, environment: 'prod' }), { mode: 'live' }, hosted)
  ).toBeNull();
  expect(scopedStats(stats(hostedScope), { mode: 'live', slot: 3 }, hosted)).toBeNull();
  expect(scopedStats(stats(hostedScope), { mode: 'fixture' }, hosted)).toBeNull();
});
