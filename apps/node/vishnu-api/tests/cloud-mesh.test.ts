import { describe, it, expect } from 'vitest';
import { canonicalApmServices, cloudMesh } from '../src/cloud-mesh.js';
import { createDatadogReader } from '../src/telemetry/datadog.js';

const empty = () =>
  createDatadogReader({ VISHNU_DATADOG_ENV: 'dev', VISHNU_DATADOG_SCOPE: 'environment' })();
describe('declared cloud connections', () => {
  it('keeps product clients visible without credentials, traffic, or fabricated health', async () => {
    const mesh = cloudMesh(await empty());
    for (const [source, target] of [
      ['saga_dash', 'sessions-api'],
      ['coach', 'coach-api'],
      ['coach', 'programs-api'],
      ['connectv3', 'connectv3-api'],
    ]) {
      const r = mesh.relationships.find(r => r.source === source && r.target === target)!;
      expect(r).toBeDefined();
      expect(r.declared).toBe(true);
      expect(r.observation).toBe('unavailable');
      expect(r.rate).toBeNull();
      expect(r.latencyMs).toBeNull();
      expect(r.health).toBe('unknown');
      expect(r.evidence[0].url).toMatch(/^https:\/\/github.com\/saga-ed\//);
    }
    expect(
      mesh.relationships.every(
        r => mesh.systems.some(s => s.id === r.source) && mesh.systems.some(s => s.id === r.target)
      )
    ).toBe(true);
    expect(
      mesh.relationships.find(r => r.source === 'connectv3' && r.target === 'authz-api')!.summary
    ).toContain('When VITE_AUTHZ_API_URL');
  });
  it('merges observed declared pairs without duplicate edges or layout churn, then retains them when quiet', async () => {
    const data = { ...(await empty()), status: 'connected' as const };
    const quiet = cloudMesh(data);
    const busy = cloudMesh({
      ...data,
      dependencies: [
        { source: 'saga_dash', target: 'iam-api' },
        { source: 'saga_dash', target: 'iam-api' },
      ],
    });
    expect(busy.topologyVersion).toBe(quiet.topologyVersion);
    const edges = busy.relationships.filter(
      r => r.source === 'saga_dash' && r.target === 'iam-api'
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].observation).toBe('observed');
    const quietEdge = quiet.relationships.find(r => r.id === edges[0].id)!;
    expect(quietEdge.observation).toBe('not-observed');
    expect(quietEdge.count).toBeNull();
    expect(quietEdge.summary).toContain('does not prove zero traffic');
  });
  it('keeps additional observed dependencies without inventing protocol and is conservative on stale/partial data', async () => {
    const data = {
      ...(await empty()),
      status: 'connected' as const,
      dependencies: [{ source: 'new-worker', target: 'iam-api' }],
    };
    const edge = cloudMesh(data).relationships.find(r => r.source === 'new-worker')!;
    expect(edge.kind).toBe('dependency');
    expect(edge.protocol).toBe('unknown');
    expect(edge.declared).toBe(false);
    expect(
      cloudMesh({
        ...data,
        serverNow: Date.parse(data.observedAt) + data.freshForMs + 1,
      }).relationships.every(r => r.observation === 'stale')
    ).toBe(true);
    expect(
      cloudMesh({ ...data, status: 'partial', dependencies: [] }).relationships.every(
        r => r.observation === 'unavailable'
      )
    ).toBe(true);
  });
  it('maps the aliased APM service onto its declared node for both the mesh and per-node signals', async () => {
    const base = await empty();
    const data = canonicalApmServices({
      ...base,
      status: 'connected' as const,
      services: [
        {
          service: 'qboard_connectv3',
          rate: null,
          p95Ms: null,
          errorRate: null,
          previousP95Ms: null,
          monitors: [],
        },
      ],
      dependencies: [
        { source: 'qboard_connectv3', target: 'connectv3-api' },
        { source: 'connectv3', target: 'connectv3-api' },
      ],
    });
    expect(data.services.map(s => s.service)).toEqual(['connectv3']);
    expect(data.dependencies).toEqual([{ source: 'connectv3', target: 'connectv3-api' }]);
    const mesh = cloudMesh(data);
    expect(mesh.systems.some(s => s.id === 'qboard_connectv3')).toBe(false);
    const edge = mesh.relationships.find(
      r => r.source === 'connectv3' && r.target === 'connectv3-api'
    )!;
    expect(edge.declared).toBe(true);
    expect(edge.observation).toBe('observed');
    expect(
      mesh.relationships.filter(r => r.source === 'connectv3' && r.target === 'connectv3-api')
    ).toHaveLength(1);
  });
  it('declares RabbitMQ participation for hosted MQ badges without inventing counts', async () => {
    const mesh = cloudMesh(await empty());
    const bus = Object.fromEntries(
      mesh.systems.filter(s => s.eventBus).map(s => [s.id, s.eventBus])
    );
    expect(bus).toEqual({
      'chat-api': { publishes: true, consumes: false },
      'content-api': { publishes: true, consumes: false },
      'iam-api': { publishes: true, consumes: false },
      'insights-api': { publishes: true, consumes: false },
      'programs-api': { publishes: true, consumes: true },
      'scheduling-api': { publishes: true, consumes: true },
      'sessions-api': { publishes: true, consumes: true },
      'transcripts-api': { publishes: true, consumes: false },
    });
    expect(mesh.relationships.some(r => r.kind === 'event')).toBe(false);
  });
});
