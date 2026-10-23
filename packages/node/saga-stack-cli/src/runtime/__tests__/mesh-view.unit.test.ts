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
      declaredRoots: [],
      slot: 2,
      processState: async id => (id === 'saga-dash' ? 'running' : 'absent'),
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
      declaredRoots: [],
      processState: async () => 'absent',
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
      declaredRoots: [],
      processState: async id => (id === 'saga-dash' ? 'running' : 'absent'),
      prober: { probe: async () => ({ ok: false }) },
      tcpProbe: async () => false,
    });
    const snapshot = await collect();
    expect(snapshot.systems.some(s => s.id === 'saga-dash')).toBe(true);
    expect(snapshot.systems.some(s => s.id === 'scheduling-api')).toBe(true);
    expect(snapshot.systems.some(s => s.id === 'iam-api')).toBe(true);
    expect(snapshot.systems.some(s => s.id === 'coach-web')).toBe(false);
    expect(snapshot.systems.find(s => s.id === 'saga-dash')?.health).toBe('critical');
    expect(snapshot.systems.find(s => s.id === 'iam-api')).toMatchObject({
      health: 'unknown',
      runtimeState: 'not-started',
    });
  });

  it('returns an empty live mesh when nothing is tracked or reachable', async () => {
    const snapshot = await createLocalMeshCollector({
      declaredRoots: [],
      processState: async () => 'absent',
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

describe('partial-stack lifecycle regression', () => {
  it('ignores old exited or unverified PID records in a reused slot', async () => {
    const snapshot = await createLocalMeshCollector({
      declaredRoots: [],
      slot: 3,
      processState: async id => (id === 'saga-dash' ? 'exited' : 'unverified'),
      prober: { probe: async url => ({ ok: url.includes(':6010/') }) },
      tcpProbe: async () => true,
    })();
    expect(snapshot.systems.filter(s => !s.id.startsWith('infra:')).map(s => s.id)).toEqual([
      'iam-api',
    ]);
    expect(snapshot.systems.every(s => s.health === 'healthy')).toBe(true);
  });

  it('keeps an observed crash critical, but an explicit stop neutral without removing topology', async () => {
    let state: 'running' | 'exited' | 'absent' = 'running';
    let healthy = true;
    const collect = createLocalMeshCollector({
      declaredRoots: [],
      processState: async id => (id === 'iam-api' ? state : 'absent'),
      prober: { probe: async url => ({ ok: healthy && url.includes(':3010/') }) },
      tcpProbe: async () => true,
    });
    const first = await collect();
    healthy = false;
    state = 'exited';
    expect((await collect()).systems.find(s => s.id === 'iam-api')).toMatchObject({
      health: 'critical',
      runtimeState: 'unhealthy',
    });
    state = 'absent';
    const stopped = await collect();
    expect(stopped.systems.find(s => s.id === 'iam-api')).toMatchObject({
      health: 'unknown',
      runtimeState: 'stopped',
    });
    expect(stopped.topologyVersion).toEqual(first.topologyVersion);
    expect(stopped.relationships).toEqual(first.relationships);
  });

  it('discovers an unhealthy HTTP responder even without a managed PID', async () => {
    const snapshot = await createLocalMeshCollector({
      declaredRoots: [],
      processState: async () => 'absent',
      prober: {
        probe: async url => (url.includes(':3010/') ? { ok: false, status: 503 } : { ok: false }),
      },
      tcpProbe: async () => true,
    })();
    expect(snapshot.systems.find(s => s.id === 'iam-api')).toMatchObject({
      health: 'critical',
      runtimeState: 'unhealthy',
    });
  });
});


it('shows the declared product mesh without marking unstarted systems critical', async () => {
  const snapshot = await createLocalMeshCollector({
    slot: 3, processState: async () => 'exited',
    prober: {probe: async () => ({ok: false})}, tcpProbe: async () => false,
  })();
  for (const id of ['sessions-api','connect-api','coach-api','saga-dash','connect-web','coach-web']) {
    expect(snapshot.systems.find(s => s.id === id)).toMatchObject({health:'unknown',runtimeState:'not-started'});
  }
  expect(snapshot.systems.filter(s => s.band === 'application').map(s => s.label)).toEqual(expect.arrayContaining(['Connectv3','Coach','saga-dash']));
  expect(snapshot.systems.some(s => s.health === 'critical')).toBe(false);
});
