import type { MeshSnapshot } from './types';

export type SignalView = 'overview' | 'hot' | 'slow' | 'attention' | 'fanout' | 'error';
export interface MetricPoint {
  at: number;
  value: number;
}
export interface DatadogService {
  service: string;
  /** Count of retained server spans; never a total request count. */
  observedSpans?: number;
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
  scope: { level?: 'environment' | 'deployment'; environment: string; deployment: string; deploymentTag: string; machine?: string };
  appUrl: string;
  window: { from: number; to: number };
  thresholds: { hotRate: number; warningP95Ms: number; criticalP95Ms: number };
  services: DatadogService[];
  dependencies: { source: string; target: string }[];
  measurementSource?: 'apm-metrics' | 'retained-spans';
  endpointSource?: 'apm-metrics' | 'retained-spans';
  endpoints?: DatadogEndpoint[];
  connections?: DatadogConnection[];
  endpointStatus?: MeasurementStatus;
  connectionStatus?: MeasurementStatus;
  endpointLimited?: boolean;
  connectionLimited?: boolean;
  pathEndpoints?: DatadogPathEndpoint[];
  pathEndpointStatus?: MeasurementStatus;
  pathEndpointLimited?: boolean;
  fanout?: DatadogFanout[];
  fanoutStatus?: MeasurementStatus;
  fanoutCoverage?: { requestedTraces: number; retrievedTraces: number; usableTraces: number; rejectedTraces: number; limited: true; basis: 'recent-retained-trace-sample'; observedAt: string };

}
export type MeasurementStatus = 'available' | 'partial' | 'unavailable' | 'unconfigured';
export interface DatadogEndpoint {
  service: string;
  resource: string;
  observedSpans?: number;
  rate: MetricPoint | null;
  p95Ms: MetricPoint | null;
  /** Errors per second, not an error percentage. */
  errorRate: MetricPoint | null;
}
export interface DatadogConnection {
  source: string;
  target: string;
  /** Retained client spans explicitly attributed by peer.service in snapshot.window; not total requests or requests/sec. */
  observedSpans: number;
  /** Duration percentile of those retained outgoing client spans, in milliseconds. */
  p95Ms: number | null;
}
export interface DatadogPathEndpoint {
  source: string;
  target: string;
  resource: string;
  /** Retained outgoing client spans, never total traffic. */
  observedSpans: number;
  p95Ms: number | null;
}
export interface DatadogFanout {
  source: string;
  target: string;
  resource: string;
  parentResource: string;
  /** Sampled same-source server requests traversing this source→target path. */
  sampledParents: number;
  observedCalls: number;
  maxCallsPerParent: number;
  meanCallsPerParent: number;
  traceIds: string[];
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
    observed: fresh && !!source,
    unavailable: failed || !!data && !['connected', 'partial'].includes(data.status),
    stale: !!source && !failed && !!data && ['connected', 'partial'].includes(data.status) && !fresh,
    measurementSource: data?.measurementSource,
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
  const scope = `env:${quote(data.scope.environment)}${data.scope.level === 'environment' ? '' : ` @${data.scope.deploymentTag}:${quote(data.scope.deployment)}`}${data.scope.machine ? ` @synthetic.machine:${quote(data.scope.machine)}` : ''}`;
  // Search is a supported span-query landing page. The user can switch to Trace Queries / Flow Map there.
  const query = `${scope}${target ? ` service:${quote(source ?? '')} @span.kind:client @peer.service:${quote(target)}` : source ? ` service:${quote(source)}` : ''}`;
  const url = new URL('/apm/traces', data.appUrl);
  url.search = new URLSearchParams({
    query,
    start: String(data.window.from),
    end: String(data.window.to),
    paused: 'true',
  }).toString();
  return url.href;
}
