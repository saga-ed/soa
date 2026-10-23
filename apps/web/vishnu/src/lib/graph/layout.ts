import type ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import { busParticipants, busPanelHeight } from './bus';
import { layoutRank, systemShape } from './presentation';
import type { MeshLayout, MeshSnapshot } from './types';

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const nodeWidth = 224;
const nodeHeight = 112;
let defaultEngine: InstanceType<typeof ELK> | undefined;
const coordinate = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** Only structural data affects geometry: telemetry and input ordering do not. */
export function topologyKey(snapshot: MeshSnapshot): string {
  return JSON.stringify({
    nodes: snapshot.systems
      .map(system => [system.id, `${layoutRank(system)}:${systemShape(system)}`])
      .sort((a, b) => compare(a[0], b[0])),
    participants: busParticipants(snapshot).map(p => p.system.id).sort(),
    edges: snapshot.relationships
      .map(({ id, source, target }) => [id, source, target])
      .sort((a, b) => compare(a[0], b[0])),
  });
}

export async function layoutMesh(
  snapshot: MeshSnapshot,
  engine?: Pick<InstanceType<typeof ELK>, 'layout'>
): Promise<MeshLayout> {
  const systems = [...snapshot.systems].sort(
    (a, b) => layoutRank(a) - layoutRank(b) || compare(a.id, b.id)
  );
  const relationships = [...snapshot.relationships].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(systems.map(system => [system.id, system]));
  if (byId.size !== systems.length) throw new Error('System IDs must be unique');
  if (new Set(relationships.map(edge => edge.id)).size !== relationships.length) {
    throw new Error('Relationship IDs must be unique');
  }
  if (!systems.length) {
    if (relationships.length) throw new Error('Relationships require existing systems');
    return { nodes: [], edges: [], width: 0, height: 0 };
  }
  // Lay out the shared infrastructure as one fixed horizontal row. ELK routes
  // against its real bottom ports, so moving these nodes never detaches edges.
  const rowSystems = systems
    .filter(system => systemShape(system) !== 'service')
    .sort(
      (a, b) =>
        ({ bus: 0, database: 1, cache: 2, service: 3 })[systemShape(a)] -
          { bus: 0, database: 1, cache: 2, service: 3 }[systemShape(b)] || compare(a.id, b.id)
    );
  const rowIds = new Set(rowSystems.map(system => system.id));
  const rowId = '__infrastructure-row__';
  const rowGap = 72;
  const rank = (system: (typeof systems)[number]) =>
    rowIds.has(system.id) ? 0 : layoutRank(system) + 1;
  const ports = new Map<string, ElkPort[]>(systems.map(system => [system.id, []]));
  const reversed = new Set<string>();
  const edges = relationships.map((edge, index) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) throw new Error(`Unknown system on relationship ${edge.id}`);
    // Cross-band orientation enforces the declared bands. Within a band, ELK
    // follows actual flow and handles cycles instead of imposing lexical ranks.
    const reverse = rank(source) > rank(target);
    const from = reverse ? target : source;
    const to = reverse ? source : target;
    if (reverse) reversed.add(edge.id);
    const fromPort = `port-${index}-source`;
    const toPort = `port-${index}-target`;
    ports.get(from.id)!.push({
      id: fromPort,
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': 'EAST' },
    });
    ports.get(to.id)!.push({
      id: toPort,
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': 'WEST' },
    });
    return { id: edge.id, sources: [fromPort], targets: [toPort] };
  });
  const rowPorts = rowSystems.flatMap((system, index) => {
    const entries = ports.get(system.id)!;
    return entries.map((port, portIndex) => ({
      ...port,
      x:
        index * (nodeWidth + rowGap) +
        24 +
        ((nodeWidth - 48) * (portIndex + 1)) / (entries.length + 1),
      y: nodeHeight,
      layoutOptions: { 'elk.port.side': 'SOUTH' },
    }));
  });
  const graph: ElkNode = {
    id: 'mesh-root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': '1',
      'elk.partitioning.activate': 'true',
      'elk.separateConnectedComponents': 'false',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.mergeHierarchyEdges': 'false',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.padding': '[top=48,left=40,bottom=40,right=40]',
    },
    children: [
      ...systems
        .filter(system => !rowIds.has(system.id))
        .map(system => ({
          id: system.id,
          width: nodeWidth,
          height: nodeHeight,
          ports: ports.get(system.id),
          layoutOptions: {
            'elk.partitioning.partition': String(rank(system)),
            'elk.portConstraints': 'FIXED_SIDE',
          },
        })),
      ...(rowSystems.length
        ? [
            {
              id: rowId,
              width: rowSystems.length * nodeWidth + (rowSystems.length - 1) * rowGap,
              height: nodeHeight,
              ports: rowPorts,
              layoutOptions: {
                'elk.partitioning.partition': '0',
                'elk.portConstraints': 'FIXED_POS',
              },
            },
          ]
        : []),
    ],
    edges,
  };
  // The browser supplies a worker-backed engine. Load the in-process engine
  // only for non-browser callers, so the algorithm is not shipped twice at startup.
  if (!engine) {
    defaultEngine ??= new (await import('elkjs/lib/elk.bundled.js')).default();
    engine = defaultEngine;
  }
  const result = await engine.layout(graph);
  return {
    nodes: (result.children ?? []).flatMap(node =>
      node.id === rowId
        ? rowSystems.map((system, index) => ({
            id: system.id,
            x: coordinate((node.x ?? 0) + index * (nodeWidth + rowGap)),
            y: coordinate(node.y ?? 0),
            width: nodeWidth,
            height: systemShape(system) === 'bus' ? nodeHeight + 16 + busPanelHeight(busParticipants(snapshot).length) : nodeHeight,
          }))
        : [
            {
              id: node.id,
              x: coordinate(node.x ?? 0),
              y: coordinate(node.y ?? 0),
              width: nodeWidth,
              height: nodeHeight,
            },
          ]
    ),
    edges: (result.edges ?? []).map(edge => {
      const section = edge.sections?.[0];
      if (!section) throw new Error(`No route for relationship ${edge.id}`);
      // Remove floating point noise so orthogonal segments remain exactly axial.
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
        point => ({ x: coordinate(point.x), y: coordinate(point.y) })
      );
      return { id: edge.id, points: reversed.has(edge.id) ? points.reverse() : points };
    }),
    width: result.width ?? 0,
    height: Math.max(result.height ?? 0, ...((result.children ?? []).filter(n => n.id === rowId).map(n => (n.y ?? 0) + nodeHeight + 16 + busPanelHeight(busParticipants(snapshot).length) + 40))),
  };
}
