import type { DatadogSnapshot, SignalView } from './datadog';
import { pathRates } from './path-rates';

export interface PathSignal {
  kind: 'hot' | 'slow' | 'fanout';
  value: number;
  unit: string;
  detail: string;
}

export const pathColors = {
  hot: 'var(--color-attention-strong)',
  slow: 'var(--color-primary)',
  fanout: 'var(--chart-2)',
};

/** Only evidence attributed to this directed pair can colour its path. */
export function pathSignal(
  data: DatadogSnapshot | null,
  source: string,
  target: string,
  view: SignalView,
  now: number,
  failed = false
): PathSignal | undefined {
  if (view === 'hot') {
    const measured = pathRates(data, source, target, now, failed);
    if (measured.value != null)
      return {
        kind: 'hot',
        value: measured.value,
        unit: 'req/s measured',
        detail: `Measured endpoints only: application counters of completed HTTP attempts, including failures. Other endpoints may be uninstrumented. ${measured.state === 'partial' ? 'Partial coverage. ' : ''}${new Date(measured.window!.from).toISOString()} – ${new Date(measured.window!.to).toISOString()}.`,
      };
  }
  if (!data || failed || !['connected', 'partial'].includes(data.status)) return;
  const age = now - Date.parse(data.observedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > data.freshForMs) return;
  if (view === 'fanout') {
    const sampleAge = now - Date.parse(data.fanoutCoverage?.observedAt ?? '');
    if (
      !['available', 'partial'].includes(data.fanoutStatus ?? '') ||
      !Number.isFinite(sampleAge) ||
      sampleAge < -60_000 ||
      sampleAge > data.freshForMs
    )
      return;
    const parents = new Map<string, { calls: number; count: number }>();
    for (const row of data.fanout ?? []) {
      if (
        row.source !== source ||
        row.target !== target ||
        !Number.isFinite(row.observedCalls) ||
        row.observedCalls < 0 ||
        !Number.isFinite(row.sampledParents) ||
        row.sampledParents <= 0
      )
        continue;
      const group = parents.get(row.parentResource) ?? { calls: 0, count: row.sampledParents };
      // Inconsistent denominators cannot establish a path-level ratio.
      if (group.count !== row.sampledParents) return;
      group.calls += row.observedCalls;
      parents.set(row.parentResource, group);
    }
    const value = Math.max(0, ...[...parents.values()].map(g => g.calls / g.count));
    if (!value) return;
    return {
      kind: 'fanout',
      value,
      unit: 'calls / sampled parent',
      detail:
        'Largest mean across sampled parent endpoints on this path. Recent retained trace sample; not a population estimate.',
    };
  }
  if (view !== 'slow' && view !== 'hot') return;
  if (!['available', 'partial'].includes(data.pathEndpointStatus ?? '')) return;
  const rows = (data.pathEndpoints ?? []).filter(r => r.source === source && r.target === target);
  if (view === 'slow') {
    const values = rows
      .map(r => r.p95Ms)
      .filter((n): n is number => n != null && Number.isFinite(n) && n >= 0);
    if (!values.length) return;
    return {
      kind: 'slow',
      value: Math.max(...values),
      unit: 'ms retained p95',
      detail:
        'Highest endpoint p95 among retained outgoing client spans on this path. A ranking, not an alert threshold.',
    };
  }
  const values = rows.map(r => r.observedSpans).filter(n => Number.isFinite(n) && n >= 0);
  if (!values.length) return;
  return {
    kind: 'hot',
    value: values.reduce((a, b) => a + b, 0),
    unit: 'retained spans',
    detail:
      'Observed outgoing client spans across returned endpoints in this window. Sampling and query limits may omit traffic.',
  };
}

export const pathEmphasized = (signal: PathSignal | undefined) =>
  !!signal && (signal.kind === 'fanout' ? signal.value > 1 : signal.value > 0);

export function pathSignalLabel(signal: PathSignal): string {
  return `${signal.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${signal.unit}`;
}
