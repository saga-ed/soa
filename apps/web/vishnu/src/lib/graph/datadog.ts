import type { MeshSnapshot } from './types';

export type SignalView = 'overview' | 'hot' | 'slow' | 'attention' | 'fanout' | 'error';
export interface MetricPoint {
  at: number;
  value: number;
}
export interface DatadogService {
  service: string;
  rate: MetricPoint | null;
  p95Ms: MetricPoint | null;
  errorRate: MetricPoint | null;
  previousP95Ms: number | null;
  monitors: { actionable?: boolean; id: number; name: string; status: string; url: string }[];
}
export interface DatadogSnapshot {
  version: 1;
  status: 'connected' | 'partial' | 'unavailable' | 'unconfigured';
  message: string;
  observedAt: string;
  serverNow: number;
  freshForMs: number;
  scope: { level?: 'environment' | 'deployment'; environment: string; deployment: string; deploymentTag: string };
  appUrl: string;
  window: { from: number; to: number };
  thresholds: { hotRate: number; warningP95Ms: number; criticalP95Ms: number };
  services: DatadogService[];
  dependencies: { source: string; target: string }[];
}
export function matchesMesh(data: DatadogSnapshot | null, mesh: MeshSnapshot | null): boolean {
  return (
    !!data &&
    mesh?.mode === 'live' &&
    (mesh.scope
      ? (data.scope.level ?? 'deployment') === (mesh.scope.level ?? 'deployment') && data.scope.environment === mesh.scope.environment && data.scope.deployment === mesh.scope.deployment && data.scope.deploymentTag === mesh.scope.deploymentTag
      : data.scope.environment === 'synthetic' && data.scope.deployment === `slot-${mesh.slot}`)
  );
}
export function currentPoint(
  point: MetricPoint | null | undefined,
  now: number,
  freshForMs: number
): number | null {
  return point &&
    Number.isFinite(point.value) &&
    point.at <= now + 60000 &&
    now - point.at <= freshForMs
    ? point.value
    : null;
}
export function serviceSignal(
  data: DatadogSnapshot | null,
  id: string,
  now: number,
  failed = false
) {
  const source = data?.services.find(s => s.service === id);
  const fresh =
    !!data &&
    !failed &&
    ['connected', 'partial'].includes(data.status) &&
    now - Date.parse(data.observedAt) <= data.freshForMs;
  const rate = fresh ? currentPoint(source?.rate, now, data!.freshForMs) : null;
  const p95Ms = fresh ? currentPoint(source?.p95Ms, now, data!.freshForMs) : null;
  const errorRate = fresh ? currentPoint(source?.errorRate, now, data!.freshForMs) : null;
  const monitors = fresh ? (source?.monitors ?? []) : [];
  const critical =
    monitors.some(m => m.actionable !== false && m.status === 'Alert') ||
    (p95Ms != null && p95Ms >= data!.thresholds.criticalP95Ms);
  const warning =
    monitors.some(m => m.actionable !== false && m.status === 'Warn') ||
    (p95Ms != null && p95Ms >= data!.thresholds.warningP95Ms);
  return {
    rate,
    p95Ms,
    errorRate,
    monitors,
    previousP95Ms: fresh ? (source?.previousP95Ms ?? null) : null,
    hot: rate != null && rate >= data!.thresholds.hotRate,
    slow: p95Ms != null && p95Ms >= data!.thresholds.warningP95Ms,
    risk: critical ? 'critical' : warning ? 'warning' : 'unknown',
    flagged: critical || warning,
  };
}
export function emphasizes(view: SignalView, signal: ReturnType<typeof serviceSignal>): boolean {
  return (
    view === 'overview' ||
    (view === 'error' ? signal.errorRate != null && signal.errorRate > 0 : view === 'hot' ? signal.hot : view === 'slow' ? signal.slow : signal.flagged)
  );
}
/** Values are quoted for Datadog search, then URL encoded; no raw query interpolation. */
export function traceLink(data: DatadogSnapshot, source?: string, target?: string): string {
  const quote = (v: string) => JSON.stringify(v);
  const scope = `env:${quote(data.scope.environment)}${data.scope.level === 'environment' ? '' : ` @${data.scope.deploymentTag}:${quote(data.scope.deployment)}`}`;
  // Search is a supported span-query landing page. The user can switch to Trace Queries / Flow Map there.
  const query = `${scope}${target ? ` service:${quote(target)} @span.parent.service:${quote(source ?? '')}` : source ? ` service:${quote(source)}` : ''}`;
  const url = new URL('/apm/traces', data.appUrl);
  url.search = new URLSearchParams({
    query,
    start: String(data.window.from),
    end: String(data.window.to),
    paused: 'true',
  }).toString();
  return url.href;
}
