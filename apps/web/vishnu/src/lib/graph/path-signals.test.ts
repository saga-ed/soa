import { describe, expect, it } from 'vitest';
import type { DatadogSnapshot } from './datadog';
import { pathEmphasized, pathSignal } from './path-signals';

const now = 1_800_000_000_000;
function sample(): DatadogSnapshot {
  return {
    version: 1, status: 'connected', message: '', observedAt: new Date(now).toISOString(),
    serverNow: now, freshForMs: 300_000,
    scope: { environment: 'synthetic', deployment: 'slot-3', deploymentTag: 'deployment.identifier' },
    appUrl: 'https://app.datadoghq.com', window: { from: now - 900_000, to: now },
    thresholds: { hotRate: 10, warningP95Ms: 2500, criticalP95Ms: 5000 },
    services: [], dependencies: [], pathEndpointStatus: 'partial', fanoutStatus: 'partial',
    pathEndpoints: [
      { source: 'programs', target: 'iam', resource: 'GET /permissions', observedSpans: 20, p95Ms: 25 },
      { source: 'programs', target: 'iam', resource: 'GET /whoami', observedSpans: 5, p95Ms: 10 },
      { source: 'scheduling', target: 'iam', resource: 'GET /permissions', observedSpans: 999, p95Ms: 9999 },
    ],
    fanoutCoverage: { requestedTraces: 1, retrievedTraces: 1, usableTraces: 1, rejectedTraces: 0,
      limited: true, basis: 'recent-retained-trace-sample', observedAt: new Date(now).toISOString() },
    fanout: ['GET /permissions', 'GET /whoami'].map(resource => ({ source: 'programs', target: 'iam',
      resource, parentResource: 'GET /programs.list', sampledParents: 2, observedCalls: 2,
      meanCallsPerParent: 1, maxCallsPerParent: 1, traceIds: ['exact-id'] })),
  };
}

describe('measured path focus', () => {
  it('uses directed path measurements without projecting service or other caller traffic', () => {
    const data = sample();
    expect(pathSignal(data, 'programs', 'iam', 'hot', now)).toMatchObject({ value: 25, unit: 'retained spans' });
    expect(pathSignal(data, 'programs', 'iam', 'slow', now)).toMatchObject({ value: 25, unit: 'ms retained p95' });
    expect(pathSignal(data, 'iam', 'programs', 'slow', now)).toBeUndefined();
    expect(pathSignal(data, 'programs', 'iam', 'attention', now)).toBeUndefined();
    data.services = [{ service: 'programs', rate: { at: now, value: 999 }, p95Ms: { at: now, value: 99999 }, errorRate: null, previousP95Ms: null, monitors: [] }];
    data.pathEndpoints = [];
    expect(pathSignal(data, 'programs', 'iam', 'slow', now)).toBeUndefined();
    expect(pathSignal(data, 'programs', 'iam', 'hot', now)).toBeUndefined();
  });
  it('combines endpoint calls for the same parent population, preserving distinct parent populations', () => {
    const data = sample();
    expect(pathSignal(data, 'programs', 'iam', 'fanout', now)?.value).toBe(2);
    data.fanout!.push({ ...data.fanout![0], parentResource: 'GET /programs.get', sampledParents: 1, observedCalls: 3 });
    expect(pathSignal(data, 'programs', 'iam', 'fanout', now)?.value).toBe(3);
    data.fanout![1].sampledParents = 8;
    expect(pathSignal(data, 'programs', 'iam', 'fanout', now)).toBeUndefined();
  });
  it('suppresses failed, stale, future and unavailable samples', () => {
    const data = sample();
    expect(pathSignal(data, 'programs', 'iam', 'slow', now, true)).toBeUndefined();
    expect(pathSignal(data, 'programs', 'iam', 'slow', now + 300_001)).toBeUndefined();
    expect(pathSignal(data, 'programs', 'iam', 'slow', now - 60_001)).toBeUndefined();
    data.pathEndpointStatus = 'unavailable';
    expect(pathSignal(data, 'programs', 'iam', 'hot', now)).toBeUndefined();
    data.fanoutCoverage!.observedAt = new Date(now - 300_001).toISOString();
    expect(pathSignal(data, 'programs', 'iam', 'fanout', now)).toBeUndefined();
  });
  it('focuses measured slow/hot paths and repeated fanout while keeping single calls as context', () => {
    const data = sample();
    expect(pathEmphasized(pathSignal(data, 'programs', 'iam', 'slow', now))).toBe(true);
    expect(pathEmphasized(pathSignal(data, 'programs', 'iam', 'fanout', now))).toBe(true);
    data.fanout = [data.fanout![0]];
    expect(pathEmphasized(pathSignal(data, 'programs', 'iam', 'fanout', now))).toBe(false);
  });
});
