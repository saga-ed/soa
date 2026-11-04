import { describe, it, expect } from 'vitest';
import type { DatadogSnapshot } from './datadog';
import { pathRates } from './path-rates';
import { pathSignal } from './path-signals';
import { rankOffenders } from './offenders';
const now = 1_800_000_000_000;
function sample(): DatadogSnapshot {
  return {
    version: 1,
    status: 'partial',
    message: '',
    observedAt: new Date(now).toISOString(),
    serverNow: now,
    freshForMs: 300000,
    scope: {
      environment: 'synthetic',
      deployment: 'slot-3',
      deploymentTag: 'deployment.identifier',
    },
    appUrl: 'https://app.datadoghq.com',
    window: { from: now - 900000, to: now },
    thresholds: { hotRate: 10, warningP95Ms: 100, criticalP95Ms: 1000 },
    services: [],
    dependencies: [],
    pathRateStatus: 'available',
    pathRateSource: 'application-counter',
    pathRateObservedAt: new Date(now).toISOString(),
    pathRateFreshForMs: 180000,
    pathRateWindow: { from: now - 120000, to: now - 60000 },
    pathRates: [
      {
        source: 'a',
        target: 'b',
        resource: 'GET /counted',
        rate: { at: now - 60000, value: 2 },
        count: 120,
      },
      {
        source: 'a',
        target: 'b',
        resource: 'GET /idle',
        rate: { at: now - 60000, value: 0 },
        count: 0,
      },
      {
        source: 'a',
        target: 'c',
        resource: 'GET /elsewhere',
        rate: { at: now - 60000, value: 999 },
        count: 59940,
      },
    ],
    pathEndpointStatus: 'available',
    pathEndpoints: [
      { source: 'a', target: 'b', resource: 'GET /sampled', observedSpans: 999, p95Ms: 10 },
    ],
  };
}
describe('verified path request rates', () => {
  it('uses directed counters with measured zeros and never ranks counts alongside rates', () => {
    const d = sample();
    expect(pathRates(d, 'a', 'b', now)).toMatchObject({ value: 2, state: 'available' });
    const ranked = rankOffenders(d, 'a', 'b', 'hot', 5, now);
    expect(ranked.rows.map(r => [r.resource, r.value, r.basis])).toEqual([
      ['GET /counted', 2, 'counter-rate'],
      ['GET /idle', 0, 'counter-rate'],
    ]);
    expect(pathSignal(d, 'a', 'b', 'hot', now)).toMatchObject({ value: 2, unit: 'req/s measured' });
    expect(pathRates(d, 'b', 'a', now)).toMatchObject({ value: null, state: 'missing' });
  });
  it('keeps counter freshness independent and falls back honestly when it expires', () => {
    const d = sample();
    d.observedAt = new Date(now - 900000).toISOString();
    expect(pathSignal(d, 'a', 'b', 'hot', now)?.unit).toBe('req/s measured');
    expect(rankOffenders(d, 'a', 'b', 'hot', 5, now).rows[0].basis).toBe('counter-rate');
    d.observedAt = new Date(now).toISOString();
    d.pathRateObservedAt = new Date(now - 180001).toISOString();
    expect(pathRates(d, 'a', 'b', now).state).toBe('stale');
    expect(pathSignal(d, 'a', 'b', 'hot', now)).toMatchObject({
      value: 999,
      unit: 'retained spans',
    });
    expect(rankOffenders(d, 'a', 'b', 'hot', 5, now).rows[0]).toMatchObject({
      value: 999,
      resource: 'GET /sampled',
    });
  });
  it('rejects missing provenance, failures, malformed or mismatched bucket values without guessing zero', () => {
    const d = sample();
    expect(pathRates(null, 'a', 'b', now).value).toBeNull();
    expect(pathRates(d, 'a', 'b', now, true).value).toBeNull();
    d.pathRateSource = undefined;
    expect(pathRates(d, 'a', 'b', now).value).toBeNull();
    d.pathRateSource = 'application-counter';
    d.pathRates![0].rate.at = now - 30000;
    expect(pathRates(d, 'a', 'b', now)).toMatchObject({ state: 'partial', value: 0 });
    d.pathRates![1].rate.value = -1;
    expect(pathRates(d, 'a', 'b', now).value).toBeNull();
    d.pathRateWindow = { from: now, to: now };
    expect(pathRates(d, 'a', 'b', now).value).toBeNull();
  });
});
