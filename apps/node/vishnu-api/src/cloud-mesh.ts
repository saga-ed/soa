import { createHash } from 'node:crypto';
import type { DatadogSnapshot } from '../../../web/vishnu/src/lib/graph/datadog';
import type { MeshSnapshot, System } from '../../../web/vishnu/src/lib/graph/types';

/** Only observed APM edges; a service measurement never becomes an edge measurement. */
export function cloudMesh(data: DatadogSnapshot): MeshSnapshot {
  const applications = new Map([['coach', 'Coach'], ['connectv3', 'Connectv3'], ['saga_dash', 'Saga Dash']]);
  const names = new Set([...applications.keys(), ...data.services.map(s => s.service),
    ...data.dependencies.flatMap(d => [d.source, d.target])]);
  const available = ['connected', 'partial'].includes(data.status);
  const fresh = available && data.serverNow - Date.parse(data.observedAt) <= data.freshForMs;
  const systems: System[] = [...names].sort().map(id => ({ id, label: applications.get(id) ?? id,
    band: applications.has(id) ? 'application' : 'mesh', kind: applications.has(id) ? 'Application' : 'Observed APM service',
    health: 'unknown', freshness: fresh && data.services.some(s => s.service === id) ? 'fresh' : 'missing',
    summary: applications.has(id) ? 'Declared application; connections appear when observed in APM.' : 'Observed in Datadog; reachability is not probed.',
    errors: null, evidence: [] }));
  const dependencies = [...new Map(data.dependencies.map(d => [JSON.stringify([d.source, d.target]), d])).values()];
  const relationships = dependencies.map(({ source, target }) => ({
    id: `apm:${source}:${target}`, source, target, label: 'APM dependency', kind: 'dependency' as const,
    protocol: 'unknown' as const, count: null, rate: null, latencyMs: null, health: 'unknown' as const,
    freshness: fresh ? 'fresh' as const : 'stale' as const,
    summary: 'Datadog APM adjacency. Protocol, call count and path latency are not supplied by this endpoint.', evidence: []
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { topologyVersion: createHash('sha256').update(JSON.stringify([data.scope, [...names].sort(), relationships.map(r => r.id)])).digest('hex').slice(0, 16),
    environment: data.scope.environment, scope: data.scope, mode: 'live', observedAt: data.observedAt,
    observationWindowSeconds: (data.window.to - data.window.from) / 1000, systems, relationships };
}
