import type { DatadogSnapshot, SignalView } from './datadog';
import type { MeshSnapshot } from './types';
import type { DemoSignal } from '../fixtures/signals';
import { pathRates } from './path-rates';

export type InvestigationView = 'hot' | 'slow' | 'fanout';
export type MetricColumn =
  | 'rate'
  | 'count'
  | 'retained'
  | 'p95'
  | 'errorPercent'
  | 'meanCalls'
  | 'maxCalls'
  | 'parents'
  | 'calls';
export type SortColumn = MetricColumn | 'source' | 'target' | 'resource' | 'parentResource';
export interface InvestigationState {
  mode: 'details' | 'table';
  expanded: boolean;
  system: string;
  direction: 'both' | 'from' | 'to';
  path: string | null;
  row: string | null;
  sort: SortColumn | null;
  sortView: InvestigationView | null;
  descending: boolean;
}
export const initialInvestigation = (): InvestigationState => ({
  mode: 'details',
  expanded: true,
  system: '',
  direction: 'both',
  path: null,
  row: null,
  sort: null,
  sortView: null,
  descending: true,
});
export const investigationView = (view: SignalView): InvestigationView =>
  view === 'slow' || view === 'fanout' ? view : 'hot';
export function selectInvestigation(
  state: InvestigationState,
  mesh: MeshSnapshot | null,
  id: string | null
): InvestigationState {
  return {
    ...state,
    system: mesh?.systems.some(s => s.id === id) ? id! : '',
    path: mesh?.relationships.some(r => r.id === id) ? id : null,
    row: null,
  };
}
export interface InvestigationRow extends Record<MetricColumn, number | null> {
  key: string;
  source: string;
  target: string;
  resource: string;
  parentResource: string;
  relationship: string | null;
  simulated: boolean;
  note: string;
}
const numeric = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const key = (source: string, target: string, resource: string, parent = '') =>
  JSON.stringify([source, target, resource, parent]);
const fresh = (at: string | undefined, now: number, ttl: number) => {
  const time = Date.parse(at ?? '');
  return Number.isFinite(time) && ttl > 0 && time <= now + 60_000 && now - time <= ttl;
};
function emptyRow(
  mesh: MeshSnapshot,
  source: string,
  target: string,
  resource: string,
  parentResource = ''
): InvestigationRow {
  return {
    key: key(source, target, resource, parentResource),
    source,
    target,
    resource,
    parentResource,
    relationship:
      mesh.relationships.find(
        r => r.source === source && r.target === target && ['http', 'dependency'].includes(r.kind)
      )?.id ?? null,
    rate: null,
    count: null,
    retained: null,
    p95: null,
    errorPercent: null,
    meanCalls: null,
    maxCalls: null,
    parents: null,
    calls: null,
    simulated: false,
    note: '',
  };
}

/** Caller-specific evidence only. Never substitute a service total for a path metric. */
export function investigationRows(
  mesh: MeshSnapshot,
  data: DatadogSnapshot | null,
  view: InvestigationView,
  now: number,
  failed = false,
  demo: Record<string, DemoSignal> = {}
) {
  const rows = new Map<string, InvestigationRow>();
  const notes: string[] = [];
  if (Object.keys(demo).length) {
    for (const relationship of mesh.relationships) {
      const signal = demo[relationship.id];
      if (!signal || (view === 'fanout' ? signal.kind !== 'fanout' : signal.kind === 'fanout'))
        continue;
      const row = emptyRow(
        mesh,
        relationship.source,
        relationship.target,
        'Path total (simulated)',
        signal.kind === 'fanout' ? 'IAM request (simulated root)' : ''
      );
      row.relationship = relationship.id;
      row.key = relationship.id;
      row.simulated = true;
      row.note = signal.detail;
      if (signal.kind === 'hot') row.rate = signal.value;
      if (signal.kind === 'slow') row.p95 = signal.value;
      if (signal.kind === 'error') row.errorPercent = signal.value;
      if (signal.kind === 'fanout') row.meanCalls = signal.value;
      rows.set(row.key, row);
    }
    return {
      rows: [...rows.values()],
      notes: [
        'SIMULATED: invented path totals, not measured endpoints. Fan-out uses the named simulated root request.',
      ],
    };
  }
  if (!data || failed)
    return {
      rows: [],
      notes: ['Measurements unavailable for this scope. Unknown does not mean zero traffic.'],
    };
  const sampleFresh =
    ['connected', 'partial'].includes(data.status) && fresh(data.observedAt, now, data.freshForMs);
  if (view === 'fanout') {
    if (
      !sampleFresh ||
      !data.fanoutCoverage ||
      !fresh(data.fanoutCoverage.observedAt, now, data.freshForMs) ||
      !['available', 'partial'].includes(data.fanoutStatus ?? '')
    ) {
      return {
        rows: [],
        notes: [
          'Fan-out samples are unavailable or stale. Calls per parent require attributable trace evidence.',
        ],
      };
    }
    for (const sample of data.fanout ?? []) {
      if (
        ![
          sample.sampledParents,
          sample.observedCalls,
          sample.meanCallsPerParent,
          sample.maxCallsPerParent,
        ].every(numeric) ||
        sample.sampledParents === 0
      )
        continue;
      const row = emptyRow(
        mesh,
        sample.source,
        sample.target,
        sample.resource,
        sample.parentResource
      );
      row.meanCalls = sample.meanCallsPerParent;
      row.maxCalls = sample.maxCallsPerParent;
      row.parents = sample.sampledParents;
      row.calls = sample.observedCalls;
      rows.set(row.key, row);
    }
    const c = data.fanoutCoverage;
    notes.push(
      `Bounded retained-trace sample: ${c.usableTraces} usable / ${c.retrievedTraces} retrieved / ${c.requestedTraces} requested; ${c.rejectedTraces} rejected. Means are per sampled parent traversing this path, not fleet-wide fan-out.`
    );
    if (data.fanoutStatus === 'partial')
      notes.push('Partial fan-out coverage. Rankings cover only returned samples.');
  } else {
    const pairs = new Map(
      (data.pathRates ?? []).map(row => [key(row.source, row.target, ''), row])
    );
    let partialCounters = false;
    for (const pair of pairs.values()) {
      const rates = pathRates(data, pair.source, pair.target, now, failed);
      if (rates.state === 'partial') partialCounters = true;
      for (const rate of rates.rows) {
        const row = emptyRow(mesh, rate.source, rate.target, rate.resource);
        row.rate = rate.rate.value;
        row.count = rate.count;
        rows.set(row.key, row);
      }
    }
    if (partialCounters)
      notes.push('Partial counter coverage. Missing rates are unknown, not zero.');
    if (sampleFresh && ['available', 'partial'].includes(data.pathEndpointStatus ?? '')) {
      for (const span of data.pathEndpoints ?? []) {
        if (!numeric(span.observedSpans) || span.observedSpans === 0) continue;
        const id = key(span.source, span.target, span.resource);
        const row = rows.get(id) ?? emptyRow(mesh, span.source, span.target, span.resource);
        row.retained = span.observedSpans;
        row.p95 = numeric(span.p95Ms) ? span.p95Ms : null;
        rows.set(id, row);
      }
      if (data.pathEndpointStatus === 'partial' || data.pathEndpointLimited)
        notes.push('Endpoint sample coverage is partial or limited.');
    } else notes.push('Retained-span latency/count measurements are unavailable or stale.');
    notes.push(
      'Requests/sec and HTTP attempts use application counters. Retained calls and p95 use sampled client spans; these may cover different windows. Path-specific error percentages are unavailable.'
    );
  }
  if (!rows.size) notes.push('No current measured calls. This does not establish zero traffic.');
  return { rows: [...rows.values()], notes };
}

export function filterInvestigation(
  rows: InvestigationRow[],
  state: InvestigationState,
  mesh: MeshSnapshot
) {
  const path = mesh.relationships.find(r => r.id === state.path);
  return rows.filter(row => {
    if (
      state.path &&
      (!path ||
        !['http', 'dependency'].includes(path.kind) ||
        row.source !== path.source ||
        row.target !== path.target)
    )
      return false;
    return (
      !state.system ||
      (state.direction !== 'to' && row.source === state.system) ||
      (state.direction !== 'from' && row.target === state.system)
    );
  });
}
export function defaultInvestigationSort(
  view: InvestigationView,
  rows: InvestigationRow[]
): SortColumn {
  return view === 'fanout'
    ? 'meanCalls'
    : view === 'slow'
      ? 'p95'
      : rows.some(row => row.rate != null)
        ? 'rate'
        : 'retained';
}
export function sortInvestigation(rows: InvestigationRow[], column: SortColumn, descending = true) {
  return [...rows].sort((a, b) => {
    const av = a[column],
      bv = b[column];
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    const compared =
      av == null || bv == null
        ? 0
        : typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
    return (descending ? -compared : compared) || a.key.localeCompare(b.key);
  });
}
