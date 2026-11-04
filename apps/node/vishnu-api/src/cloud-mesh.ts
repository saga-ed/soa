import { createHash } from 'node:crypto';
import type { DatadogSnapshot } from '../../../web/vishnu/src/lib/graph/datadog';
import type { MeshSnapshot, System, Relationship } from '../../../web/vishnu/src/lib/graph/types';
import { apmServiceAliases, applicationLabels, declaredConnections, declaredEventBus } from './declared-topology.js';

/** Rename aliased APM services to their declared node id, so mesh edges and per-node signals agree. */
export function canonicalApmServices(data: DatadogSnapshot): DatadogSnapshot {
  const id = (service: string) => apmServiceAliases.get(service) ?? service;
  const seen = new Set<string>();
  return {
    ...data,
    services: data.services.map(s => ({ ...s, service: id(s.service) })),
    dependencies: data.dependencies
      .map(d => ({ ...d, source: id(d.source), target: id(d.target) }))
      .filter(d => {
        const k = JSON.stringify([d.source, d.target]);
        return !seen.has(k) && !!seen.add(k);
      }),
  };
}

/** Source-declared topology survives quiet windows. APM overlays never invent edge metrics. */
export function cloudMesh(data: DatadogSnapshot): MeshSnapshot {
  const available = ['connected', 'partial'].includes(data.status);
  const fresh = available && data.serverNow - Date.parse(data.observedAt) <= data.freshForMs;
  const key = (source: string, target: string) => JSON.stringify([source, target]);
  const dependencies = new Map(data.dependencies.map(d => [key(d.source, d.target), d]));
  const relationships: Relationship[] = declaredConnections.map(d => {
    const observed = dependencies.has(key(d.source, d.target));
    dependencies.delete(key(d.source, d.target));
    const observation = !available
      ? 'unavailable'
      : !fresh
        ? 'stale'
        : observed
          ? 'observed'
          : data.status === 'partial'
            ? 'unavailable'
            : 'not-observed';
    return {
      id: `declared:${d.source}:${d.target}`,
      source: d.source,
      target: d.target,
      label: `${applicationLabels.get(d.source) ?? d.source} → ${applicationLabels.get(d.target) ?? d.target}`,
      kind: d.protocol ? 'http' : 'dependency',
      protocol: d.protocol,
      declared: true,
      observation,
      count: null,
      rate: null,
      latencyMs: null,
      health: 'unknown',
      freshness:
        observation === 'observed' ? 'fresh' : observation === 'stale' ? 'stale' : 'missing',
      summary: `Source-declared connection. ${d.condition ?? 'Declared by an application client.'} ${observation === 'observed' ? 'Also observed in the current APM window.' : observation === 'not-observed' ? 'Not observed in the current APM window; this does not prove zero traffic or an outage.' : 'Current APM observation is unavailable or stale.'} Deployed configuration is not independently verified. Edge traffic and latency remain unknown.`,
      evidence: [
        {
          label: 'Source declaration',
          description: `${d.repo}/${d.path} (reviewed 2026-10-24). ${d.condition ?? ''}`,
          url: `https://github.com/saga-ed/${d.repo}/blob/main/${d.path}`,
        },
      ],
    };
  });
  for (const { source, target } of dependencies.values())
    relationships.push({
      id: `apm:${source}:${target}`,
      source,
      target,
      label: 'APM dependency',
      kind: 'dependency',
      protocol: 'unknown',
      declared: false,
      observation: fresh ? 'observed' : available ? 'stale' : 'unavailable',
      count: null,
      rate: null,
      latencyMs: null,
      health: 'unknown',
      freshness: fresh ? 'fresh' : 'stale',
      summary:
        'Observed APM adjacency without a source declaration. Protocol, call count and path latency are not supplied by this endpoint.',
      evidence: [],
    });
  relationships.sort((a, b) => a.id.localeCompare(b.id));
  const names = new Set([
    ...applicationLabels.keys(),
    ...declaredEventBus.keys(),
    ...data.services.map(s => s.service),
    ...relationships.flatMap(r => [r.source, r.target]),
  ]);
  const declaredNames = new Set(declaredConnections.flatMap(d => [d.source, d.target]));
  const systems: System[] = [...names]
    .sort()
    .map(id => ({
      id,
      label: applicationLabels.get(id) ?? id,
      band: applicationLabels.has(id) ? 'application' : 'mesh',
      kind: applicationLabels.has(id) ? 'Application' : 'API / service',
      health: 'unknown',
      freshness: fresh && data.services.some(s => s.service === id) ? 'fresh' : 'missing',
      observationSource:
        fresh && data.services.some(s => s.service === id)
          ? 'apm'
          : declaredNames.has(id)
            ? 'declared'
            : 'apm',
      summary:
        'Source declarations describe supported wiring; APM supplies observations. Reachability and deployed client configuration are not probed.',
      errors: null,
      evidence: [],
      ...(declaredEventBus.has(id) ? { eventBus: declaredEventBus.get(id) } : {}),
    }));
  return {
    topologyVersion: createHash('sha256')
      .update(JSON.stringify([data.scope, [...names].sort(), relationships.map(r => r.id)]))
      .digest('hex')
      .slice(0, 16),
    environment: data.scope.environment,
    scope: data.scope,
    mode: 'live',
    observedAt: data.observedAt,
    observationWindowSeconds: (data.window.to - data.window.from) / 1000,
    systems,
    relationships,
  };
}
