import { expect, it } from 'vitest';
import { eventRates, eventRateLabel } from './event-rates';
import { EventStats, compareReports } from '@saga-ed/soa-event-stats';
import {
  hostedMqLabel,
  hostedMqScope,
  scopedStats,
  serviceStats,
  type StatsSnapshot,
  type StatsSource,
} from './event-stats';
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
it('keeps the untagged hosted scope and label unchanged when no sandbox tag is configured (d9)', () => {
  const config = { environment: 'dev', mqDeployment: 'main' };
  expect(hostedMqScope(config)).toEqual({ environment: 'dev', deployment: 'main' });
  expect(hostedMqLabel(hostedMqScope(config)!)).toBe('dev / main');
  expect(hostedMqScope({ environment: 'dev', mqDeployment: null })).toBeNull();
  expect(hostedMqScope({ mqDeployment: 'main' })).toBeNull();
});
it('observes exactly one named sandbox and labels it apart from the environment-wide APM view (d9)', () => {
  const config = {
    environment: 'dev',
    mqDeployment: 'sandbox-gh537',
    mqPreviewTag: 'sandbox-gh537',
  };
  const hosted = hostedMqScope(config)!;
  expect(hosted).toEqual({
    environment: 'dev',
    deployment: 'sandbox-gh537',
    previewTag: 'sandbox-gh537',
  });
  expect(hostedMqLabel(hosted)).toBe(
    'dev / sandbox-gh537 · patch-party sandbox; APM stays dev-wide'
  );
  // A tag that disagrees with the exact deployment is refused rather than guessed.
  expect(hostedMqScope({ ...config, mqPreviewTag: 'sandbox-other' })).toBeNull();
  const stats = (deployment: string): StatsSnapshot => ({
    version: 1,
    scope: { environment: 'dev', deployment, broker: 'shared-dev-mq', vhost: '/' },
    observedAt: now,
    staleAfterMs: 90000,
    sources: [],
    receiver: { connected: true },
  });
  expect(scopedStats(stats('sandbox-gh537'), { mode: 'live' }, hosted)).not.toBeNull();
  expect(scopedStats(stats('main'), { mode: 'live' }, hosted)).toBeNull();
  expect(scopedStats(stats('sandbox-other'), { mode: 'live' }, hosted)).toBeNull();
});
it('uses the newest process epoch once even when an older report arrives later', () => {
  const old = source('one', 99),
    current = source('one', 2);
  old.report.startedAt = new Date(Date.parse(now) - 60000).toISOString();
  current.report.startedAt = new Date(Date.parse(now) - 1000).toISOString();
  old.receivedAt = new Date(Date.parse(now) + 1000).toISOString();
  old.report.sequence = 999;
  const view = serviceStats(snapshot([current, old]), 'programs-api');
  expect(view.sources).toHaveLength(1);
  expect(metric(view)).toMatchObject({ count: 2, rate: 2 });
  current.comparison = compareReports(old.report, current.report);
  expect(metric(serviceStats(snapshot([old, current]), 'programs-api')).rate).toBeNull();
});
it('describes mixed instance intervals and partial coverage without converting missing data to zero', () => {
  const a = source('one', 6, 2000),
    b = source('two', 9, 3000);
  const row = metric(serviceStats(snapshot([a, b]), 'programs-api'));
  expect(row.rate).toBe(6);
  expect(row.rateCoverage).toMatchObject({
    measuredInstances: 2,
    totalInstances: 2,
    partial: false,
    aligned: false,
  });
  expect(row.rateCoverage.windows.map(w => w.intervalMs)).toEqual([2000, 3000]);
  b.comparison = null;
  expect(metric(serviceStats(snapshot([a, b]), 'programs-api'))).toMatchObject({
    rate: null,
    rateCoverage: { partial: true, measuredInstances: 1, totalInstances: 2 },
  });
  b.freshness = 'stale';
  expect(metric(serviceStats(snapshot([a, b]), 'programs-api'))).toMatchObject({
    rate: 3,
    rateCoverage: { partial: true, measuredInstances: 1, totalInstances: 2 },
  });
  a.report.streams = [];
  a.comparison = { status: 'advanced', intervalMs: 1000, streams: [] };
  expect(metric(serviceStats(snapshot([a]), 'programs-api')).rate).toBeNull();
});
it('does not renew stale counters just because their delivery was delayed', () => {
  const delayed = source();
  delayed.report.observedAt = new Date(Date.parse(now) - 90001).toISOString();
  expect(serviceStats(snapshot([delayed]), 'programs-api').status).toBe('Stale');
});

it('labels independent event actions and preserves unknown confirmation', () => {
  const view = serviceStats(snapshot([source('one', 4, 2000)]), 'programs-api');
  expect(eventRates(view, 'producer').map(r => [r.key, r.value])).toEqual([
    ['publishAccepted', 2],
    ['publishConfirmed', null],
  ]);
  expect(eventRateLabel(view, true, false)).toBe('Accepted 2/s');
  expect(eventRates(undefined, 'consumer').every(r => r.value === null)).toBe(true);
});
it('treats a decreased same-epoch counter as unknown instead of zero throughput', () => {
  const original = source('one', 5);
  const reset = structuredClone(original.report);
  reset.sequence++;
  reset.elapsedMs += 1000;
  reset.streams[0].counters.publishAccepted = 0;
  const comparison = compareReports(original.report, reset);
  const view = serviceStats(snapshot([{ ...original, report: reset, comparison }]), 'programs-api');
  expect(metric(view).count).toBe(0);
  expect(metric(view).rate).toBeNull();
  expect(metric(view).rateCoverage.partial).toBe(true);
});
