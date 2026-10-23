import type { Counter, Report, ReportComparison } from '@saga-ed/soa-event-stats';
export interface StatsSource {
  report: Report;
  receivedAt: string;
  freshness: 'fresh' | 'stale';
  comparison: ReportComparison | null;
}
export interface StatsSnapshot {
  version: 1;
  scope: Pick<Report['identity'], 'environment' | 'deployment' | 'broker' | 'vhost'>;
  observedAt: string;
  staleAfterMs: number;
  sources: StatsSource[];
  receiver: { connected: boolean };
}
export const measurements: { key: Counter; label: string; role: 'producer' | 'consumer' }[] = [
  { key: 'publishAccepted', label: 'Publish accepted', role: 'producer' },
  { key: 'deliveries', label: 'Deliveries', role: 'consumer' },
  { key: 'commits', label: 'Committed work', role: 'consumer' },
  { key: 'duplicates', label: 'Duplicate skips', role: 'consumer' },
  { key: 'processingFailures', label: 'Processing failures', role: 'consumer' },
  { key: 'publishAttempts', label: 'Publish attempts', role: 'producer' },
  { key: 'publishFailures', label: 'Publish failures', role: 'producer' },
  { key: 'publishConfirmed', label: 'Broker confirmed', role: 'producer' },
  { key: 'redeliveries', label: 'Redeliveries', role: 'consumer' },
  { key: 'ackIssued', label: 'Ack issued', role: 'consumer' },
  { key: 'nackIssued', label: 'Nack issued', role: 'consumer' },
  { key: 'ackFailed', label: 'Ack failures', role: 'consumer' },
  { key: 'nackFailed', label: 'Nack failures', role: 'consumer' },
  { key: 'requeues', label: 'Requeue requests', role: 'consumer' },
];
const sum = (values: (number | null | undefined)[]) => {
  if (values.some(v => v == null || !Number.isFinite(v))) return null;
  const total = (values as number[]).reduce((a, b) => a + b, 0);
  return total < Number.MAX_SAFE_INTEGER ? total : null;
};
export function serviceStats(
  snapshot: StatsSnapshot | null,
  service: string,
  elapsedMs = 0,
  unavailable = false
) {
  const unique = new Map<string, StatsSource>();
  for (const source of snapshot?.sources ?? []) {
    const identity = source.report.identity;
    if (
      identity.service !== service ||
      Object.entries(snapshot!.scope).some(([k, v]) => identity[k as keyof typeof identity] !== v)
    )
      continue;
    const key = JSON.stringify([identity, source.report.epoch]);
    if (!unique.has(key) || unique.get(key)!.report.sequence < source.report.sequence)
      unique.set(key, source);
  }
  const sources = [...unique.values()];
  const observed = Date.parse(snapshot?.observedAt ?? '');
  const fresh = unavailable
    ? []
    : sources.filter(
        s =>
          s.freshness === 'fresh' &&
          observed + elapsedMs - Date.parse(s.receivedAt) <= snapshot!.staleAfterMs
      );
  const metric = (key: Counter, role: 'producer' | 'consumer', rate = false) => {
    const capable = fresh.filter(s => s.report.capabilities.includes(role));
    if (!capable.length) return null;
    return sum(
      capable.map(s => {
        if (rate && (s.comparison?.status !== 'advanced' || !s.comparison.intervalMs)) return null;
        const rows = rate ? s.comparison!.streams : s.report.streams;
        const relevant = rows.filter(row => row.stream.role === role);
        if (!relevant.length && key === 'publishConfirmed') return null;
        return sum(relevant.map(row => ('counters' in row ? row.counters[key] : row.rates[key])));
      })
    );
  };
  return {
    status: unavailable
      ? 'Unavailable'
      : !sources.length
        ? 'No reports'
        : !fresh.length
          ? 'Stale'
          : 'Live',
    sources,
    fresh,
    stale: sources.length - fresh.length,
    latestReceivedAt: sources.length
      ? new Date(Math.max(...sources.map(s => Date.parse(s.receivedAt)))).toISOString()
      : null,
    rows: measurements.map(m => ({
      ...m,
      count: metric(m.key, m.role),
      rate: metric(m.key, m.role, true),
    })),
  };
}
export type ServiceStats = ReturnType<typeof serviceStats>;
export type MqViews = Record<string, ServiceStats>;
export const numberLabel = (value: number | null, rate = false) =>
  value == null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: rate ? 2 : 0 });
