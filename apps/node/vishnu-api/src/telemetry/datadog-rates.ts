import type { DatadogPathRate, DatadogSnapshot, MeasurementStatus } from '../../../../web/vishnu/src/lib/graph/datadog';

type Scope = DatadogSnapshot['scope'];
export const PATH_RATE_METRIC = 'saga.http.client.requests';
export const PATH_RATE_ACTIVE_METRIC = 'saga.http.client.metrics.active';
export const PATH_RATE_CACHE_MS = 30000;
export const PATH_RATE_FRESH_MS = 180000;
export const PATH_RATE_BUCKET_MS = 60000;
export type PathRateSnapshot = Required<Pick<DatadogSnapshot, 'pathRates' | 'pathRateStatus' | 'pathRateSource' | 'pathRateObservedAt' | 'pathRateFreshForMs' | 'pathRateWindow'>>;

/** Separate fast metric cache; retained trace evidence keeps its own longer cache. */
export function createPathRateReader(
  scope: Scope,
  query: (params: Record<string, string>) => Promise<any>,
  state: () => 'ready' | 'unavailable' | 'unconfigured',
  now = Date.now,
) {
  let cache: PathRateSnapshot | undefined;
  let cachedAt = 0;
  let pending: Promise<PathRateSnapshot> | undefined;
  const collect = async (): Promise<PathRateSnapshot> => {
    const at = now();
    // Leave one complete minute for export/ingestion. No partial rightmost bucket.
    const to = Math.floor(at / PATH_RATE_BUCKET_MS) * PATH_RATE_BUCKET_MS - PATH_RATE_BUCKET_MS;
    const window = { from: to - PATH_RATE_BUCKET_MS, to };
    const base: PathRateSnapshot = {
      pathRates: [], pathRateStatus: 'unavailable', pathRateSource: 'application-counter',
      pathRateObservedAt: new Date(at).toISOString(), pathRateFreshForMs: PATH_RATE_FRESH_MS, pathRateWindow: window,
    };
    const configured = state();
    if (configured !== 'ready') return { ...base, pathRateStatus: configured };
    const tags = [`env:${scope.environment}`, 'source.service:programs-api', 'peer.service:iam-api'];
    const groups = ['source.service', 'peer.service', 'http.method', 'http.route', 'env'];
    if (scope.level !== 'environment') { tags.push(`${scope.deploymentTag}:${scope.deployment}`); groups.push(scope.deploymentTag); }
    if (scope.machine) { tags.push(`synthetic.machine:${scope.machine}`); groups.push('synthetic.machine'); }
    try {
      const params = { from: String(window.from / 1000), to: String(window.to / 1000 - 1) };
      const [result, active] = await Promise.all([
        query({ ...params, query: `sum:${PATH_RATE_METRIC}{${tags.join(',')}} by {${groups.join(',')}}.as_count().rollup(sum,60)` }),
        query({ ...params, query: `sum:${PATH_RATE_ACTIVE_METRIC}{${tags.join(',')}} by {${groups.join(',')}}.rollup(min,10).fill(null)` }),
      ]);
      return { ...base, ...pathRateMeasurements(result, scope, window, active) };
    } catch { return base; }
  };
  return async (): Promise<PathRateSnapshot> => {
    if (cache && now() - cachedAt < PATH_RATE_CACHE_MS) return cache;
    pending ??= collect().then(value => { cache = value; cachedAt = now(); return value; }).finally(() => { pending = undefined; });
    return pending;
  };
}

/** Count metric buckets only: never interpolate, divide retained spans, or manufacture missing zeros. */
export function pathRateMeasurements(result: any, scope: Scope, window: { from: number; to: number }, active: any): Pick<PathRateSnapshot, 'pathRates' | 'pathRateStatus'> {
  if (result?.status !== 'ok' || !Array.isArray(result.series) || result.errors || result.error || active?.status !== 'ok' || !Array.isArray(active.series) || active.errors || active.error)
    return { pathRates: [], pathRateStatus: 'unavailable' };
  const rows = new Map<string, DatadogPathRate>();
  const seen = new Set<string>();
  const identity = (tags: unknown) => Array.isArray(tags) && tags.every(t => typeof t === 'string') ? JSON.stringify([...tags].sort()) : '';
  // Pilot exporters run every ten seconds. A single heartbeat cannot establish
  // a full minute after startup, shutdown or an export gap; require all six bins.
  const live = new Set<string>(active.series.filter((s: any) => s?.interval === 10 && Array.isArray(s.pointlist) && Array.from({ length: 6 }, (_, i) => window.from + i * 10000).every(at => {
    const points = s.pointlist.filter((p: unknown[]) => Array.isArray(p) && p[0] === at);
    return points.length === 1 && typeof points[0][1] === 'number' && Number.isFinite(points[0][1]) && points[0][1] > 0;
  })).map((s: any) => identity(s.tag_set)));
  let partial = false;
  for (const series of result.series) {
    const tags = new Map<string, string>();
    for (const tag of series?.tag_set ?? []) {
      if (typeof tag !== 'string' || !tag.includes(':')) continue;
      const split = tag.indexOf(':'); tags.set(tag.slice(0, split), tag.slice(split + 1));
    }
    const source = tags.get('source.service'), target = tags.get('peer.service');
    const method = tags.get('http.method')?.toUpperCase(), path = tags.get('http.route');
    const scoped = tags.get('env') === scope.environment && (scope.level === 'environment' || tags.get(scope.deploymentTag) === scope.deployment) && (!scope.machine || tags.get('synthetic.machine') === scope.machine);
    if (!live.has(identity(series.tag_set)) || !scoped || source !== 'programs-api' || target !== 'iam-api' || !method || !/^[A-Z]{1,16}$/.test(method) || !path?.startsWith('/') || path.length > 490 || /[\u0000-\u001f]/.test(path) || series.interval !== PATH_RATE_BUCKET_MS / 1000 || !Array.isArray(series.pointlist)) { partial = true; continue; }
    const bucket = series.pointlist.filter((p: unknown[]) => Array.isArray(p) && p[0] === window.from);
    if (bucket.length !== 1 || typeof bucket[0][1] !== 'number' || !Number.isFinite(bucket[0][1]) || bucket[0][1] < 0) { partial = true; continue; }
    const count = bucket[0][1];
    // Datadog lowercases metric tags. Restore only the pilot's explicit route identity.
    const canonicalPath = path === '/trpc/personas.getmypermissions' ? '/trpc/personas.getMyPermissions' : path;
    const resource = `${method} ${canonicalPath}`;
    const key = JSON.stringify([source, target, resource]);
    if (seen.has(key)) { rows.delete(key); partial = true; continue; }
    seen.add(key);
    if (rows.size >= 200) { partial = true; continue; }
    rows.set(key, { source, target, resource, count, rate: { at: window.to, value: count / ((window.to - window.from) / 1000) } });
  }
  const pathRateStatus: MeasurementStatus = partial ? 'partial' : rows.size ? 'available' : 'unavailable';
  return { pathRates: [...rows.values()], pathRateStatus };
}
