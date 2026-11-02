import type { DatadogSnapshot, SignalView } from './datadog';

export const TOP_N_STORAGE_KEY = 'vishnu.topN';
export function normalizeTopN(value: unknown): number {
  if (value == null || value === '') return 5;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(50, Math.trunc(number))) : 5;
}
export type OffenderRow = { resource: string; parentResource?: string; value: number; observedCalls: number; sampledParents?: number; maxCallsPerParent?: number };
export function rankOffenders(data: DatadogSnapshot | null, source: string, target: string, view: SignalView, topN: number, now: number, failed = false, supported = true) {
  const result = (state: 'available' | 'partial' | 'empty' | 'stale' | 'unavailable' | 'unsupported', rows: OffenderRow[] = [], total = 0) => ({ state, rows, total });
  if (!supported || !['slow', 'hot', 'fanout'].includes(view)) return result('unsupported');
  if (!data || failed || !['connected', 'partial'].includes(data.status)) return result('unavailable');
  const snapshotAt = Date.parse(data.observedAt);
  if (!Number.isFinite(snapshotAt) || snapshotAt > now + 60_000 || now - snapshotAt > data.freshForMs) return result('stale');
  if (view === 'fanout' && !data.fanoutCoverage) return result('unavailable');
  const at = Date.parse(view === 'fanout' ? data.fanoutCoverage!.observedAt : data.observedAt);
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > data.freshForMs) return result('stale');
  const status = view === 'fanout' ? data.fanoutStatus : data.pathEndpointStatus;
  if (!status || !['available', 'partial'].includes(status)) return result('unavailable');
  const rows: OffenderRow[] = view === 'fanout'
    ? (data.fanout ?? []).filter(row => row.source === source && row.target === target && Number.isFinite(row.sampledParents) && row.sampledParents > 0 && Number.isFinite(row.observedCalls) && row.observedCalls >= 0 && Number.isFinite(row.maxCallsPerParent) && row.maxCallsPerParent >= 0 && Number.isFinite(row.meanCallsPerParent) && row.meanCallsPerParent >= 0).map(row => ({ resource: row.resource, parentResource: row.parentResource, value: row.meanCallsPerParent, observedCalls: row.observedCalls, sampledParents: row.sampledParents, maxCallsPerParent: row.maxCallsPerParent }))
    : (data.pathEndpoints ?? []).filter(row => row.source === source && row.target === target && Number.isFinite(row.observedSpans) && row.observedSpans > 0 && (view !== 'slow' || row.p95Ms != null && Number.isFinite(row.p95Ms) && row.p95Ms >= 0)).map(row => ({ resource: row.resource, value: view === 'slow' ? row.p95Ms! : row.observedSpans, observedCalls: row.observedSpans }));
  rows.sort((a, b) => b.value - a.value || (b.maxCallsPerParent ?? 0) - (a.maxCallsPerParent ?? 0) || a.resource.localeCompare(b.resource) || (a.parentResource ?? '').localeCompare(b.parentResource ?? ''));
  return result(rows.length ? status === 'partial' ? 'partial' : 'available' : 'empty', rows.slice(0, normalizeTopN(topN)), rows.length);
}
