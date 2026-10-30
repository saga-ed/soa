import { describe, expect, it } from 'vitest';
import { layerBound, layoutMesh, topologyKey } from './layout';
import type { Band, MeshLayout, MeshSnapshot, Relationship, System } from './types';
import { createFixture } from '../fixtures/mesh';

const system = (id: string, band: Band): System => ({
  id,
  band,
  label: id,
  kind: 'service',
  health: 'healthy',
  freshness: 'fresh',
  summary: '',
  errors: 0,
  evidence: [],
});
const edge = (id: string, source: string, target: string): Relationship => ({
  id,
  source,
  target,
  label: id,
  kind: 'http',
  count: 1,
  rate: 1,
  latencyMs: 1,
  health: 'healthy',
  freshness: 'fresh',
  summary: '',
  evidence: [],
});
const fixture = (): MeshSnapshot => ({
  topologyVersion: '1',
  environment: 'dev',
  mode: 'fixture',
  observedAt: '',
  observationWindowSeconds: 300,
  systems: [
    system('postgres', 'data'),
    system('iam', 'mesh'),
    system('programs', 'mesh'),
    system('scheduling', 'mesh'),
    system('dashboard', 'application'),
    system('admin', 'application'),
    system('idle-db', 'data'),
  ],
  relationships: [
    edge('db-iam', 'iam', 'postgres'),
    edge('db-programs', 'programs', 'postgres'),
    edge('iam-programs', 'iam', 'programs'),
    edge('programs-iam', 'programs', 'iam'),
    edge('iam-programs-event', 'iam', 'programs'),
    edge('programs-scheduling', 'programs', 'scheduling'),
    edge('dashboard-iam', 'dashboard', 'iam'),
    edge('dashboard-scheduling', 'dashboard', 'scheduling'),
    edge('admin-iam', 'admin', 'iam'),
    edge('admin-scheduling', 'admin', 'scheduling'),
  ],
});

const denseFixture = (): MeshSnapshot => {
  const snapshot = fixture();
  snapshot.systems = [
    ...Array.from({ length: 3 }, (_, i) => system(`db-${i}`, 'data')),
    ...Array.from({ length: 16 }, (_, i) => system(`service-${i}`, 'mesh')),
    ...Array.from({ length: 6 }, (_, i) => system(`app-${i}`, 'application')),
  ];
  snapshot.relationships = [];
  for (let i = 0; i < 16; i++) {
    snapshot.relationships.push(edge(`storage-${i}`, `service-${i}`, `db-${i % 3}`));
    for (let j = i + 1; j < 16; j++) {
      if ((i + j) % 4 === 0)
        snapshot.relationships.push(edge(`mesh-${i}-${j}`, `service-${i}`, `service-${j}`));
    }
  }
  // K(6, 4) is nonplanar and stresses application fan-out.
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 4; j++) {
      snapshot.relationships.push(edge(`api-${i}-${j}`, `app-${i}`, `service-${j}`));
    }
  return snapshot;
};

/** Hosted shape: apps fan out to a wide mesh band, many services report APM only. */
const hostedFixture = (): MeshSnapshot => {
  const snapshot = fixture();
  snapshot.systems = [
    ...Array.from({ length: 26 }, (_, i) => system(`api-${i}`, 'mesh')),
    ...Array.from({ length: 3 }, (_, i) => system(`web-${i}`, 'application')),
  ];
  snapshot.relationships = [
    ...Array.from({ length: 11 }, (_, i) => edge(`dash-${i}`, 'web-0', `api-${i}`)),
    ...[1, 2, 11].map(i => edge(`coach-${i}`, 'web-1', `api-${i}`)),
    ...[1, 12, 13].map(i => edge(`connect-${i}`, 'web-2', `api-${i}`)),
    ...[2, 3, 4].map(i => edge(`mesh-${i}`, `api-${i}`, 'api-1')),
  ];
  return snapshot;
};

function crossingCount(layout: MeshLayout) {
  let count = 0;
  for (let a = 0; a < layout.edges.length; a++) {
    for (let b = a + 1; b < layout.edges.length; b++) {
      const first = layout.edges[a].points;
      const second = layout.edges[b].points;
      for (let i = 1; i < first.length; i++)
        for (let j = 1; j < second.length; j++) {
          const a1 = first[i - 1],
            a2 = first[i],
            b1 = second[j - 1],
            b2 = second[j];
          const verticalA = a1.x === a2.x,
            verticalB = b1.x === b2.x;
          if (verticalA === verticalB) continue;
          const [v1, v2, h1, h2] = verticalA ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
          if (
            v1.x > Math.min(h1.x, h2.x) &&
            v1.x < Math.max(h1.x, h2.x) &&
            h1.y > Math.min(v1.y, v2.y) &&
            h1.y < Math.max(v1.y, v2.y)
          )
            count++;
        }
    }
  }
  return count;
}

function expectClearGeometry(layout: MeshLayout) {
  for (const a of layout.nodes) {
    for (const b of layout.nodes) {
      if (a.id >= b.id) continue;
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y
      ).toBe(true);
    }
  }
  for (const route of layout.edges) {
    route.points.slice(1).forEach((end, index) => {
      const start = route.points[index];
      expect(
        start.x === end.x || start.y === end.y,
        `${route.id}: ${JSON.stringify([start, end])}`
      ).toBe(true);
      for (const node of layout.nodes) {
        const crosses =
          start.x === end.x
            ? start.x > node.x &&
              start.x < node.x + node.width &&
              Math.max(start.y, end.y) > node.y &&
              Math.min(start.y, end.y) < node.y + node.height
            : start.y > node.y &&
              start.y < node.y + node.height &&
              Math.max(start.x, end.x) > node.x &&
              Math.min(start.x, end.x) < node.x + node.width;
        expect(crosses, `${route.id} crosses ${node.id}`).toBe(false);
      }
    });
  }
}

describe('mesh layout', () => {
  it('keeps shared infrastructure on one row with RabbitMQ first and routes clear', async () => {
    const snapshot = fixture();
    snapshot.systems.push(system('rabbitmq', 'mesh'), system('redis', 'data'));
    snapshot.relationships.push(edge('cache', 'iam', 'redis'));
    const layout = await layoutMesh(snapshot);
    const row = ['rabbitmq', 'postgres', 'redis'].map(
      id => layout.nodes.find(node => node.id === id)!
    );
    expect(new Set(row.map(node => node.y)).size).toBe(1);
    expect(row[0].x + row[0].width).toBeLessThan(row[1].x);
    expect(row[1].x + row[1].width).toBeLessThan(row[2].x);
    expectClearGeometry(layout);
  });
  it('follows same-band flow rather than alphabetic service order', async () => {
    const snapshot = fixture();
    snapshot.systems = [system('z-publisher', 'mesh'), system('a-consumer', 'mesh')];
    snapshot.relationships = [edge('published', 'z-publisher', 'a-consumer')];
    const layout = await layoutMesh(snapshot);
    const publisher = layout.nodes.find(node => node.id === 'z-publisher')!;
    const consumer = layout.nodes.find(node => node.id === 'a-consumer')!;
    expect(publisher.x + publisher.width).toBeLessThan(consumer.x);
  });

  it('keeps dense nonplanar routes clear of 25 nodes with shared databases', async () => {
    const snapshot = denseFixture();
    const layout = await layoutMesh(snapshot);
    expectClearGeometry(layout);
    expect(crossingCount(layout)).toBeGreaterThan(0);
    // A measured fixed-order baseline (NONE/OFF + forceNodeModelOrder) has
    // 438 proper segment crossings with elkjs 0.11.1 on this same fixture.
    expect(crossingCount(layout)).toBeLessThan(438);
  });

  it('wraps a wide mesh band to fill wide canvases and stack on narrow ones', async () => {
    const snapshot = hostedFixture();
    const ultrawide = await layoutMesh(snapshot, undefined, 21 / 9);
    const phone = await layoutMesh(snapshot, undefined, 0.8);
    expectClearGeometry(ultrawide);
    expectClearGeometry(phone);
    // An unbounded layer stacked these 26 services into one column (about 1:2).
    expect(ultrawide.width / ultrawide.height).toBeGreaterThan(1.6);
    expect(phone.width / phone.height).toBeLessThan(ultrawide.width / ultrawide.height);
    // Wrapping stays inside the band: every application remains right of the mesh.
    const node = (id: string) => ultrawide.nodes.find(node => node.id === id)!;
    const meshEdge = Math.max(
      ...ultrawide.nodes.filter(n => n.id.startsWith('api')).map(n => n.x + n.width)
    );
    for (const app of ['web-0', 'web-1', 'web-2']) expect(node(app).x).toBeGreaterThan(meshEdge);
  });

  it('bounds layers by canvas shape only, so equal bounds give equal layouts', async () => {
    const snapshot = hostedFixture();
    expect(layerBound(snapshot, 21 / 9)).toBeLessThan(layerBound(snapshot, 16 / 9));
    expect(layerBound(snapshot, 16 / 9)).toBeLessThan(layerBound(snapshot, 0.8));
    expect(layerBound(fixture(), 21 / 9)).toBe(3);
    expect(await layoutMesh(snapshot, undefined, 2.3)).toEqual(
      await layoutMesh(snapshot, undefined, 2.31)
    );
  });

  it('routes a self-loop back to its actual system without crossing nodes', async () => {
    const snapshot = fixture();
    snapshot.relationships.push(edge('iam-self', 'iam', 'iam'));
    const layout = await layoutMesh(snapshot);
    expectClearGeometry(layout);
    const route = layout.edges.find(route => route.id === 'iam-self')!;
    const node = layout.nodes.find(node => node.id === 'iam')!;
    expect(route.points[0].x).toBe(node.x + node.width);
    expect(route.points.at(-1)!.x).toBe(node.x);
  });

  it('routes the application preview fixture without node collisions', async () => {
    expectClearGeometry(await layoutMesh(createFixture()));
  });

  it('keeps bands ordered and routes clear of nodes, including disconnected systems', async () => {
    const snapshot = fixture();
    const layout = await layoutMesh(snapshot);
    const rank = { data: 0, mesh: 1, application: 2 };
    for (const a of snapshot.systems)
      for (const b of snapshot.systems) {
        if (rank[a.band] >= rank[b.band]) continue;
        const left = layout.nodes.find(node => node.id === a.id)!;
        const right = layout.nodes.find(node => node.id === b.id)!;
        expect(left.x + left.width).toBeLessThan(right.x);
      }
    expectClearGeometry(layout);
  });

  it('preserves real directions and separates reciprocal and parallel routes', async () => {
    const snapshot = fixture();
    const layout = await layoutMesh(snapshot);
    for (const relationship of snapshot.relationships) {
      const route = layout.edges.find(route => route.id === relationship.id)!;
      const source = layout.nodes.find(node => node.id === relationship.source)!;
      const target = layout.nodes.find(node => node.id === relationship.target)!;
      const first = route.points[0];
      const last = route.points.at(-1)!;
      expect(
        first.x === source.x ||
          first.x === source.x + source.width ||
          first.y === source.y + source.height
      ).toBe(true);
      expect(first.x).toBeGreaterThanOrEqual(source.x);
      expect(first.x).toBeLessThanOrEqual(source.x + source.width);
      expect(first.y).toBeGreaterThanOrEqual(source.y);
      expect(first.y).toBeLessThanOrEqual(source.y + source.height);
      expect(
        last.x === target.x ||
          last.x === target.x + target.width ||
          last.y === target.y + target.height
      ).toBe(true);
      expect(last.x).toBeGreaterThanOrEqual(target.x);
      expect(last.x).toBeLessThanOrEqual(target.x + target.width);
      expect(last.y).toBeGreaterThanOrEqual(target.y);
      expect(last.y).toBeLessThanOrEqual(target.y + target.height);
    }
    const related = layout.edges.filter(route =>
      ['iam-programs', 'programs-iam', 'iam-programs-event'].includes(route.id)
    );
    const portYs = related.map(route =>
      route.id === 'programs-iam' ? route.points.at(-1)!.y : route.points[0].y
    );
    expect(new Set(portYs).size).toBe(3);
  });

  it('is deterministic after input shuffle and telemetry changes', async () => {
    const original = fixture();
    const changed = structuredClone(original);
    changed.systems.reverse();
    changed.relationships.reverse();
    changed.observedAt = 'later';
    changed.systems[0].health = 'critical';
    changed.relationships[0].rate = 999;
    changed.relationships[0].count = 20;
    expect(topologyKey(changed)).toBe(topologyKey(original));
    expect(await layoutMesh(changed)).toEqual(await layoutMesh(original));
    changed.relationships[0].target = 'programs';
    expect(topologyKey(changed)).not.toBe(topologyKey(original));
  });

  it('handles empty topology and rejects dangling relationships', async () => {
    const snapshot = fixture();
    await expect(layoutMesh({ ...snapshot, systems: [], relationships: [] })).resolves.toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
    snapshot.relationships[0].source = 'missing';
    await expect(layoutMesh(snapshot)).rejects.toThrow('Unknown system');
  });
});
