import type { DatadogFanout, DatadogPathEndpoint, DatadogSnapshot, MeasurementStatus } from '../../../../web/vishnu/src/lib/graph/datadog';

type Scope = DatadogSnapshot['scope'];
type Result = PromiseSettledResult<any>;
export const pathGroupLimits = [10, 10, 5, 20]; // Product 10,000: Datadog's total-group limit.
export const traceSampleLimit = 5;
const safeService = /^[a-zA-Z0-9_.:/-]+$/;
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const id = (n: unknown): string | undefined => typeof n === 'string' && /^\d{1,20}$/.test(n) ? n : typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? String(n) : undefined;
const pathResource = (method: unknown, path: unknown): string | undefined => typeof method === 'string' && /^[A-Z]{1,16}$/.test(method) && typeof path === 'string' && path.startsWith('/') && path.length <= 490 && !/[\u0000-\u001f]/.test(path) ? `${method} ${path}` : undefined;

/** Preserve uint64 IDs before JavaScript rounds them. Node 24 supplies the original JSON token. */
export function parseDatadogJson(body: string): any {
  return JSON.parse(body, function (key, value) {
    if (/^(spanID|parentID|traceID|span_id|parent_id|trace_id)$/.test(key) && typeof value === 'number') {
      const context = arguments[2] as { source?: string } | undefined;
      if (context?.source && /^\d+$/.test(context.source)) return context.source;
      if (Number.isSafeInteger(value) && value >= 0) return String(value);
      throw new Error('Exact trace identifiers unavailable');
    }
    return value;
  });
}

export function pathEndpointMeasurements(results: Result[]) {
  const rows = new Map<string, DatadogPathEndpoint>();
  let failures = 0;
  let limited = false;
  for (const result of results) {
    if (result.status !== 'fulfilled' || !Array.isArray(result.value?.data) || result.value.errors) { failures++; continue; }
    if (result.value.meta?.status !== 'done' || result.value.meta?.warnings?.length) limited = true;
    const dimensions = [new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>()];
    for (const bucket of result.value.data) {
      const { by, compute } = bucket?.attributes ?? {};
      const source = by?.service, target = by?.['@peer.service'];
      const resource = pathResource(by?.['@http.method'], by?.['@http.path_group']);
      if (typeof source !== 'string' || typeof target !== 'string' || !safeService.test(source) || !safeService.test(target) || !resource || !nonnegative(compute?.c0)) { limited = true; continue; }
      [source, target, by['@http.method'], by['@http.path_group']].forEach((v, i) => dimensions[i].add(v));
      if (source === target) continue;
      const key = JSON.stringify([source, target, resource]);
      if (rows.size >= 400 && !rows.has(key)) { limited = true; continue; }
      // Both rankings cover the same window. Union records; never sum duplicate buckets.
      rows.set(key, { source, target, resource, observedSpans: compute.c0, p95Ms: nonnegative(compute.c1) ? compute.c1 / 1e6 : null });
    }
    if (dimensions.some((d, i) => d.size >= pathGroupLimits[i])) limited = true;
  }
  return { pathEndpoints: [...rows.values()], pathEndpointStatus: (failures === results.length ? 'unavailable' : failures || limited ? 'partial' : 'available') as MeasurementStatus, pathEndpointLimited: limited };
}

function spanInScope(span: any, scope: Scope) {
  const meta = span?.meta ?? {};
  return meta.env === scope.environment && ((scope.level ?? 'deployment') === 'environment' || meta[scope.deploymentTag] === scope.deployment) && (!scope.machine || meta['synthetic.machine'] === scope.machine);
}

/** A bounded retained-trace sample, conditional on observed parent requests traversing each path. */
export function sampledFanout(traces: { traceId: string; result: Result }[], scope: Scope, observedAt: string) {
  const groups = new Map<string, { source: string; target: string; parentResource: string; parents: Map<string, Map<string, number>>; traces: Set<string> }>();
  let retrieved = 0, usable = 0, rejected = 0;
  for (const { traceId, result } of traces) {
    if (result.status !== 'fulfilled') { rejected++; continue; }
    retrieved++;
    const attributes = result.value?.data?.attributes;
    const spans = attributes?.spans;
    if (attributes?.is_truncated !== false || !Array.isArray(spans) || spans.length > 10000 || spans.some((s: any) => !s || typeof s !== 'object' || s.restricted)) { rejected++; continue; }
    const byId = new Map<string, any>();
    let invalid = false;
    for (const s of spans) {
      const spanId = id(s.spanID ?? s.span_id), parentId = id(s.parentID ?? s.parent_id ?? '0');
      if (!spanId || !parentId || byId.has(spanId)) { invalid = true; break; }
      byId.set(spanId, { ...s, exactId: spanId, exactParent: parentId });
    }
    if (invalid) { rejected++; continue; }
    const traceGroups: { source: string; target: string; parentResource: string; resource: string; parentId: string }[] = [];
    for (const client of byId.values()) {
      if (client.meta?.['span.kind'] !== 'client' || !spanInScope(client, scope)) continue;
      const source = client.service, target = client.meta?.['peer.service'];
      if (typeof source !== 'string' || typeof target !== 'string' || !safeService.test(source) || !safeService.test(target) || source === target) continue;
      let resource = pathResource(client.meta?.['http.method'], client.meta?.['http.path_group']);
      if (!resource) {
        // A recorded callee server child may carry the normalized path when its client does not.
        const callee = [...byId.values()].find(s => s.exactParent === client.exactId && s.service === target && s.meta?.['span.kind'] === 'server' && spanInScope(s, scope));
        if (callee) resource = pathResource(callee.meta?.['http.method'], callee.meta?.['http.path_group']);
      }
      if (!resource) { invalid = true; break; }
      if (resource.includes('/health')) continue;
      let parent = byId.get(client.exactParent);
      const seen = new Set<string>([client.exactId]);
      while (parent && !seen.has(parent.exactId) && !(parent.service === source && parent.meta?.['span.kind'] === 'server')) {
        seen.add(parent.exactId); parent = byId.get(parent.exactParent);
      }
      if (!parent || seen.has(parent.exactId) || !spanInScope(parent, scope)) { invalid = true; break; }
      const parentResource = pathResource(parent.meta?.['http.method'], parent.meta?.['http.path_group']);
      if (!parentResource) { invalid = true; break; }
      traceGroups.push({ source, target, resource, parentResource, parentId: `${traceId}:${parent.exactId}` });
    }
    if (invalid) { rejected++; continue; }
    usable++;
    for (const row of traceGroups) {
      const key = JSON.stringify([row.source, row.target, row.parentResource]);
      if (!groups.has(key)) groups.set(key, { source: row.source, target: row.target, parentResource: row.parentResource, parents: new Map(), traces: new Set() });
      const group = groups.get(key)!;
      group.traces.add(traceId);
      if (!group.parents.has(row.parentId)) group.parents.set(row.parentId, new Map());
      const counts = group.parents.get(row.parentId)!;
      counts.set(row.resource, (counts.get(row.resource) ?? 0) + 1);
    }
  }
  const fanout: DatadogFanout[] = [];
  for (const group of groups.values()) for (const resource of new Set([...group.parents.values()].flatMap(p => [...p.keys()]))) {
    const counts = [...group.parents.values()].map(p => p.get(resource) ?? 0);
    const observedCalls = counts.reduce((a, b) => a + b, 0);
    fanout.push({ source: group.source, target: group.target, resource, parentResource: group.parentResource, sampledParents: counts.length, observedCalls, maxCallsPerParent: Math.max(...counts), meanCallsPerParent: observedCalls / counts.length, traceIds: [...group.traces] });
  }
  return { fanout, fanoutStatus: (traces.length && !usable ? 'unavailable' : 'partial') as MeasurementStatus,
    fanoutCoverage: { requestedTraces: traces.length, retrievedTraces: retrieved, usableTraces: usable, rejectedTraces: rejected, limited: true as const, basis: 'recent-retained-trace-sample' as const, observedAt } };
}
