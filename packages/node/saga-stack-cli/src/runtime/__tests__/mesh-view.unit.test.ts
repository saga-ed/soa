import { describe, it, expect } from 'vitest';
import { createLocalMeshCollector } from '../mesh-view.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeRealProber } from '../health.js';

describe('Vishnu local mesh collector', () => {
  it('uses the selected slot, declares real dependencies, and never invents measurements', async () => {
    const urls: string[] = [];
    const ports: number[] = [];
    const collect = createLocalMeshCollector({
      slot: 2,
      hasPidFile: async id => id === 'saga-dash',
      prober: {
        probe: async url => {
          urls.push(url);
          return { ok: true, status: 200 };
        },
      },
      tcpProbe: async port => {
        ports.push(port);
        return true;
      },
      now: () => new Date('2026-10-20T12:00:00Z'),
    });
    const snapshot = await collect();
    expect(snapshot.mode).toBe('live');
    expect(snapshot.slot).toBe(2);
    expect(urls).toContain('http://127.0.0.1:5010/health');
    expect(urls).not.toContain('http://127.0.0.1:3010/health');
    expect(ports).toContain(7432);
    expect(ports).toContain(7672);
    expect(snapshot.systems.find(s => s.id === 'iam-api')?.health).toBe('healthy');
    expect(
      snapshot.relationships.find(r => r.id === 'dep:programs-api:sessions-api')
    ).toMatchObject({
      source: 'programs-api',
      target: 'sessions-api',
      kind: 'event',
      via: ['infra:rabbitmq'],
    });
    expect(
      snapshot.relationships.every(r => r.rate === null && r.count === null && r.latencyMs === null)
    ).toBe(true);
    expect(snapshot.systems.every(s => s.errors === null)).toBe(true);
    expect(snapshot.relationships.some(r => r.label === 'iam_local')).toBe(true);
    const json = JSON.stringify(snapshot);
    for (const forbidden of ['ownerPw', 'DATABASE_URL', 'postgres://', 'amqp://', 'launch.env']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('retains a discovered service and stable topology when it goes down', async () => {
    let reachable = true;
    const collect = createLocalMeshCollector({
      hasPidFile: async () => false,
      prober: { probe: async url => ({ ok: reachable && url.includes(':3010/') }) },
      tcpProbe: async () => false,
    });
    const first = await collect();
    reachable = false;
    const second = await collect();
    expect(first.systems.find(s => s.id === 'iam-api')?.health).toBe('healthy');
    expect(second.systems.find(s => s.id === 'iam-api')?.health).toBe('critical');
    expect(second.topologyVersion).toEqual(first.topologyVersion);
    expect(second.relationships).toEqual(first.relationships);
  });

  it('includes declared dependencies of a tracked process even when none respond', async () => {
    const collect = createLocalMeshCollector({
      hasPidFile: async id => id === 'saga-dash',
      prober: { probe: async () => ({ ok: false }) },
      tcpProbe: async () => false,
    });
    const snapshot = await collect();
    expect(snapshot.systems.some(s => s.id === 'saga-dash')).toBe(true);
    expect(snapshot.systems.some(s => s.id === 'scheduling-api')).toBe(true);
    expect(snapshot.systems.some(s => s.id === 'iam-api')).toBe(true);
    expect(snapshot.systems.some(s => s.id === 'coach-web')).toBe(false);
    expect(snapshot.systems.every(s => s.health === 'critical')).toBe(true);
  });

  it('returns an empty live mesh when nothing is tracked or reachable', async () => {
    const snapshot = await createLocalMeshCollector({
      hasPidFile: async () => false,
      prober: { probe: async () => ({ ok: false }) },
      tcpProbe: async () => false,
    })();
    expect(snapshot.systems).toEqual([]);
    expect(snapshot.relationships).toEqual([]);
    expect(snapshot.mode).toBe('live');
  });

  it('does not follow health redirects beyond the configured local endpoint', async () => {
    let followed = false;
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(302, { location: '/unexpected-target' });
      } else {
        followed = true;
        res.writeHead(200);
      }
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const probe = await makeRealProber({ followRedirects: false }).probe(
        `http://127.0.0.1:${port}/health`
      );
      expect(probe.ok).toBe(false);
      expect(followed).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  });
});
