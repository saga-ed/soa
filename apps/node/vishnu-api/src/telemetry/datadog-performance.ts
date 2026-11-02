import type { DatadogConnection, DatadogEndpoint, MeasurementStatus } from '../../../../web/vishnu/src/lib/graph/datadog';

const safeService = /^[a-zA-Z0-9_.:/-]+$/;
const endpointLimit = 200;
export const connectionGroupLimit = 20;
type Result = PromiseSettledResult<any>;
const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Metric points retain their source timestamps; a successful fetch does not make old points fresh. */
export function endpointMeasurements(results: Result[], from: number, to: number) {
  const endpoints = new Map<string, DatadogEndpoint>();
  let failed = 0;
  let limited = false;
  for (const [index, field] of (['rate', 'p95Ms', 'errorRate'] as const).entries()) {
    const result = results[index];
    if (result?.status !== 'fulfilled' || result.value?.status !== 'ok' || !Array.isArray(result.value.series)) {
      failed++;
      continue;
    }
    for (const series of result.value.series) {
      const tags: unknown = series.tag_set ?? String(series.scope ?? '').split(',');
      if (!Array.isArray(tags)) continue;
      const service = tags.find(t => typeof t === 'string' && t.startsWith('service:'))?.slice(8);
      const resource = tags.find(t => typeof t === 'string' && t.startsWith('resource_name:'))?.slice(14);
      // Missing resource identity must never turn a service aggregate into an endpoint measurement.
      if (!service || !safeService.test(service) || !resource || resource.length > 512 || /[\u0000-\u001f]/.test(resource)) continue;
      const key = JSON.stringify([service, resource]);
      if (!endpoints.has(key)) {
        if (endpoints.size >= endpointLimit) { limited = true; continue; }
        endpoints.set(key, { service, resource, rate: null, p95Ms: null, errorRate: null });
      }
      if (!Array.isArray(series.pointlist)) continue;
      const points = series.pointlist.filter((p: unknown) => Array.isArray(p) && validNumber(p[0]) && validNumber(p[1]) && p[0] >= from && p[0] <= to)
        .sort((a: number[], b: number[]) => a[0] - b[0]);
      const latest = points.at(-1);
      if (latest) endpoints.get(key)![field] = { at: latest[0], value: latest[1] * (field === 'p95Ms' ? 1000 : 1) };
    }
  }
  const status: MeasurementStatus = failed === 3 ? 'unavailable' : failed || limited ? 'partial' : 'available';
  return { endpoints: [...endpoints.values()], endpointStatus: status, endpointLimited: limited };
}

/** Only client spans with explicit peer-service attribution qualify; dependency declarations carry no measurements. */
export function connectionMeasurements(result: Result) {
  const connections: DatadogConnection[] = [];
  if (result.status !== 'fulfilled' || !Array.isArray(result.value?.data) || result.value.errors)
    return { connections, connectionStatus: 'unavailable' as MeasurementStatus, connectionLimited: false };
  let malformed = false;
  for (const bucket of result.value.data) {
    const { by, compute } = bucket?.attributes ?? {};
    const source = by?.service;
    const target = by?.['@peer.service'];
    if (typeof source !== 'string' || typeof target !== 'string' || !safeService.test(source) || !safeService.test(target) || !validNumber(compute?.c0)) {
      malformed = true;
      continue;
    }
    // Same-service parentage is internal structure, not a service-to-service connection.
    if (source === target) continue;
    connections.push({ source, target, observedSpans: compute.c0, p95Ms: validNumber(compute.c1) ? compute.c1 / 1_000_000 : null });
  }
  const limited = new Set(connections.map(c => c.source)).size >= connectionGroupLimit ||
    new Set(connections.map(c => c.target)).size >= connectionGroupLimit;
  const partial = malformed || limited || result.value.meta?.status !== 'done' || !!result.value.meta?.warnings?.length;
  return { connections, connectionStatus: (partial ? 'partial' : 'available') as MeasurementStatus, connectionLimited: limited };
}

/** Scoped retained-span evidence, not an estimate of unsampled request volume. */
export function retainedEndpointMeasurements(result: Result, to: number) {
  const endpoints: DatadogEndpoint[] = [];
  if (result.status !== 'fulfilled' || !Array.isArray(result.value?.data) || result.value.errors)
    return { endpoints, endpointStatus: 'unavailable' as MeasurementStatus, endpointLimited: false };
  let malformed = false;
  for (const bucket of result.value.data) {
    const { by, compute } = bucket?.attributes ?? {};
    const service = by?.service;
    const method = by?.['@http.method'];
    const path = by?.['@http.path_group'];
    const resource = typeof method === 'string' && /^[A-Z]{1,16}$/.test(method) && typeof path === 'string' && path.startsWith('/') ? `${method} ${path}` : undefined;
    if (typeof service !== 'string' || !safeService.test(service) || typeof resource !== 'string' || !resource || resource.length > 512 || /[\u0000-\u001f]/.test(resource) || !validNumber(compute?.c0)) {
      malformed = true;
      continue;
    }
    endpoints.push({ service, resource, observedSpans: compute.c0, rate: null, errorRate: null,
      p95Ms: validNumber(compute.c1) ? { at: to, value: compute.c1 / 1_000_000 } : null });
    if (endpoints.length === endpointLimit) break;
  }
  const limited = endpoints.length >= endpointLimit || new Set(endpoints.map(e => e.service)).size >= connectionGroupLimit || new Set(endpoints.map(e => e.resource)).size >= connectionGroupLimit;
  const partial = malformed || limited || result.value.meta?.status !== 'done' || !!result.value.meta?.warnings?.length;
  return { endpoints, endpointStatus: (partial ? 'partial' : 'available') as MeasurementStatus, endpointLimited: limited };
}
