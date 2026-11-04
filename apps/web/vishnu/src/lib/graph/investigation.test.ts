import { describe, it, expect } from 'vitest';
import {
  investigationRows,
  initialInvestigation,
  selectInvestigation,
  filterInvestigation,
  sortInvestigation,
  defaultInvestigationSort,
} from './investigation';
import type { DatadogSnapshot } from './datadog';
import type { MeshSnapshot } from './types';
import { createSignalDemo, demoSignals } from '../fixtures/signals';

const now = Date.parse('2026-11-03T20:00:00Z');
const mesh = {
  systems: ['a', 'b', 'c'].map(id => ({ id })),
  relationships: [
    { id: 'ab', source: 'a', target: 'b', kind: 'http' },
    { id: 'ca', source: 'c', target: 'a', kind: 'http' },
    { id: 'db', source: 'a', target: 'b', kind: 'database' },
  ],
} as MeshSnapshot;
const sample = (): DatadogSnapshot => ({
  version: 1,
  status: 'connected',
  observedAt: new Date(now).toISOString(),
  serverNow: now,
  freshForMs: 300000,
  message: '',
  scope: { environment: 'synthetic', deployment: 'slot-3', deploymentTag: 'deployment.identifier' },
  appUrl: 'https://app.datadoghq.com',
  window: { from: now - 900000, to: now },
  thresholds: { hotRate: 10, warningP95Ms: 2500, criticalP95Ms: 5000 },
  services: [],
  dependencies: [],
  pathEndpointStatus: 'available',
  pathEndpoints: [
    { source: 'a', target: 'b', resource: 'GET /shared', observedSpans: 6, p95Ms: 900 },
    { source: 'c', target: 'a', resource: 'GET /shared', observedSpans: 12, p95Ms: 100 },
    { source: 'a', target: 'b', resource: 'GET /sample-only', observedSpans: 20, p95Ms: null },
  ],
  pathRateSource: 'application-counter',
  pathRateStatus: 'available',
  pathRateObservedAt: new Date(now).toISOString(),
  pathRateFreshForMs: 180000,
  pathRateWindow: { from: now - 120000, to: now - 60000 },
  pathRates: [
    {
      source: 'a',
      target: 'b',
      resource: 'GET /shared',
      count: 120,
      rate: { at: now - 60000, value: 2 },
    },
    {
      source: 'a',
      target: 'b',
      resource: 'GET /idle',
      count: 0,
      rate: { at: now - 60000, value: 0 },
    },
  ],
  fanoutStatus: 'available',
  fanoutCoverage: {
    observedAt: new Date(now).toISOString(),
    requestedTraces: 3,
    retrievedTraces: 3,
    usableTraces: 2,
    rejectedTraces: 1,
    limited: true,
    basis: 'recent-retained-trace-sample',
  },
  fanout: [
    {
      source: 'a',
      target: 'b',
      resource: 'GET /shared',
      parentResource: 'GET /parent-one',
      sampledParents: 2,
      observedCalls: 10,
      meanCallsPerParent: 5,
      maxCallsPerParent: 8,
      traceIds: [],
    },
    {
      source: 'a',
      target: 'b',
      resource: 'GET /shared',
      parentResource: 'GET /parent-two',
      sampledParents: 4,
      observedCalls: 8,
      meanCallsPerParent: 2,
      maxCallsPerParent: 3,
      traceIds: [],
    },
  ],
});
describe('Call investigation', () => {
  it('joins exact caller/callee/resource while preserving independent metrics and real zeros', () => {
    const rows = investigationRows(mesh, sample(), 'hot', now).rows;
    expect(rows).toHaveLength(4);
    expect(rows.find(r => r.source === 'a' && r.resource === 'GET /shared')).toMatchObject({
      rate: 2,
      count: 120,
      retained: 6,
      p95: 900,
      errorPercent: null,
    });
    expect(rows.find(r => r.source === 'c')).toMatchObject({
      rate: null,
      count: null,
      retained: 12,
      p95: 100,
    });
    expect(rows.find(r => r.resource === 'GET /idle')).toMatchObject({
      rate: 0,
      count: 0,
      retained: null,
      p95: null,
    });
    expect(defaultInvestigationSort('hot', rows)).toBe('rate');
  });
  it('keeps unknowns last in both sort directions without mixing rates and samples', () => {
    const rows = investigationRows(mesh, sample(), 'hot', now).rows;
    expect(sortInvestigation(rows, 'rate').map(r => r.rate)).toEqual([2, 0, null, null]);
    expect(sortInvestigation(rows, 'rate', false).map(r => r.rate)).toEqual([0, 2, null, null]);
    expect(sortInvestigation(rows, 'p95').map(r => r.p95)).toEqual([900, 100, null, null]);
    const data = sample();
    data.pathRates = [];
    expect(defaultInvestigationSort('hot', investigationRows(mesh, data, 'hot', now).rows)).toBe(
      'retained'
    );
  });
  it('filters both/from/to and exact path; rejects non-HTTP selections without hiding the inventory', () => {
    const rows = investigationRows(mesh, sample(), 'hot', now).rows;
    let state = selectInvestigation(initialInvestigation(), mesh, 'a');
    expect(filterInvestigation(rows, state, mesh)).toHaveLength(4);
    state.direction = 'from';
    expect(filterInvestigation(rows, state, mesh)).toHaveLength(3);
    state.direction = 'to';
    expect(filterInvestigation(rows, state, mesh)).toHaveLength(1);
    state = selectInvestigation(state, mesh, 'ab');
    expect(filterInvestigation(rows, state, mesh)).toHaveLength(3);
    state = selectInvestigation(state, mesh, 'db');
    expect(filterInvestigation(rows, state, mesh)).toEqual([]);
    state = selectInvestigation(state, mesh, null);
    expect(filterInvestigation(rows, state, mesh)).toHaveLength(4);
  });
  it('does not attach endpoint totals to individual fan-out parents', () => {
    const rows = investigationRows(mesh, sample(), 'fanout', now).rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.key)).size).toBe(2);
    expect(rows.map(r => r.meanCalls)).toEqual([5, 2]);
    expect(rows.every(r => r.rate === null && r.count === null && r.p95 === null)).toBe(true);
  });
  it('expires the independent sample/counter windows and rejects future/malformed observations', () => {
    const data = sample();
    data.observedAt = new Date(now - 900000).toISOString();
    expect(
      investigationRows(mesh, data, 'hot', now).rows.every(
        r => r.p95 === null && r.retained === null
      )
    ).toBe(true);
    expect(investigationRows(mesh, data, 'hot', now).rows).toHaveLength(2);
    expect(investigationRows(mesh, data, 'fanout', now).rows).toEqual([]);
    data.pathRateWindow!.to = now - 900000;
    expect(investigationRows(mesh, data, 'hot', now).rows).toEqual([]);
    data.observedAt = new Date(now + 900000).toISOString();
    expect(investigationRows(mesh, data, 'slow', now).rows).toEqual([]);
    expect(investigationRows(mesh, sample(), 'hot', now, true).rows).toEqual([]);
    const invalid = sample();
    invalid.pathEndpoints![0].p95Ms = NaN;
    invalid.fanout![0].sampledParents = 0;
    expect(
      investigationRows(mesh, invalid, 'slow', now).rows.find(
        r => r.resource === 'GET /shared' && r.source === 'a'
      )?.p95
    ).toBeNull();
    expect(investigationRows(mesh, invalid, 'fanout', now).rows).toHaveLength(1);
  });
  it('labels demo path totals and their root denominator without inventing endpoint counts', () => {
    const rows = investigationRows(
      createSignalDemo(),
      null,
      'fanout',
      now,
      false,
      demoSignals
    ).rows;
    expect(rows[0]).toMatchObject({
      simulated: true,
      meanCalls: 50,
      parents: null,
      calls: null,
      resource: 'Path total (simulated)',
      parentResource: 'IAM request (simulated root)',
    });
  });
});
