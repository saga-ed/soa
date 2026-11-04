import type { MeshSnapshot } from '../../../../web/vishnu/src/lib/graph/types';
import type { ResourceSnapshot } from '../../../../web/vishnu/src/lib/graph/assistant';

/** A worker may have resource evidence without emitting APM spans or declaring HTTP edges. */
export function withResourceSystems(mesh: MeshSnapshot, data?: ResourceSnapshot): MeshSnapshot {
  if (
    !data ||
    data.status !== 'ready' ||
    mesh.scope?.environment !== data.scope.environment ||
    mesh.scope.deployment !== data.scope.deployment
  )
    return mesh;
  const known = new Set(mesh.systems.map(s => s.id));
  const added = [
    ...new Set(
      data.instances.filter(r => Date.now() - Date.parse(r.observedAt) < 180_000).map(r => r.system)
    ),
  ]
    // Generic infrastructure/container names need an explicit identity map; never guess that "api" is a service.
    .filter(
      id =>
        !known.has(id) &&
        (/^[a-z][a-z0-9-]*-(api|worker)$/.test(id) ||
          ['authz-sync', 'recording-extractor'].includes(id))
    )
    .sort()
    .map(id => ({
      id,
      label: id,
      band: 'mesh' as const,
      kind: id.endsWith('-api') ? 'API service' : 'Worker service',
      health: 'unknown' as const,
      freshness: 'fresh' as const,
      errors: null,
      summary:
        'Observed container resources in Datadog. Resource reporting does not prove application health or establish call relationships.',
      evidence: [
        {
          label: 'Container resource observation',
          description: `${data.scope.environment} / ${data.scope.deployment}; ${data.observedAt}`,
        },
      ],
    }));
  return added.length
    ? {
        ...mesh,
        topologyVersion: mesh.topologyVersion + ':resources:' + added.map(s => s.id).join(','),
        systems: [...mesh.systems, ...added],
      }
    : mesh;
}
