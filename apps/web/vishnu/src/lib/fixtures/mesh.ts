import type { MeshSnapshot, Relationship, System } from '../graph/types';

export type Scenario = 'overview' | 'incident' | 'missing';

const system = (id: string, label: string, band: System['band'], kind: string): System => ({
  id,
  label,
  band,
  kind,
  health: 'healthy',
  freshness: 'fresh',
  errors: 0,
  summary: 'Illustrative system state. This preview does not query a running environment.',
  evidence: [
    {
      label: 'Fixture observation',
      description:
        'Invented measurements for interaction and layout validation. No production health claim.',
    },
  ],
});

const relationship = (
  id: string,
  source: string,
  target: string,
  kind: Relationship['kind'],
  label: string,
  count: number,
  rate: number
): Relationship => ({
  id,
  source,
  target,
  kind,
  ...(kind === 'http' ? { protocol: id === 'staff-iam' ? 'rest' as const : id === 'dash-iam' ? 'mixed' as const : 'trpc' as const } : {}),
  label,
  count,
  rate,
  latencyMs: kind === 'http' ? 82 : null,
  health: 'healthy',
  freshness: 'fresh',
  summary:
    kind === 'event'
      ? 'Logical event path through RabbitMQ. Receiving an event here does not prove the target committed its projection.'
      : kind === 'database'
        ? 'Database relationship. Flow direction identifies the operation shown; it does not describe every read and write.'
        : 'Direct API request path. Arrow points from caller to server.',
  evidence: [
    {
      label: 'Declared relationship',
      description:
        'Fixture topology inspired by source discovery; endpoint/event counts and rates are invented.',
    },
  ],
});

/**
 * Scenario changes deliberately preserve all topology and IDs: live observations
 * must not move systems, remove idle paths, or reset the investigation viewport.
 */
export function createFixture(scenario: Scenario = 'overview'): MeshSnapshot {
  const systems = [
    system('iam-db', 'IAM database', 'data', 'PostgreSQL'),
    system('programs-db', 'Programs database', 'data', 'PostgreSQL'),
    system('scheduling-db', 'Scheduling database', 'data', 'PostgreSQL'),
    system('iam', 'IAM API', 'mesh', 'Identity service'),
    system('programs', 'Programs API', 'mesh', 'Program service'),
    system('scheduling', 'Scheduling API', 'mesh', 'Scheduling service'),
    system('broker', 'RabbitMQ', 'mesh', 'Shared broker'),
    system('dash', 'Saga dashboard', 'application', 'Web application'),
    system('staff', 'Staff console', 'application', 'Web application'),
  ];
  const relationships = [
    relationship('iam-store', 'iam', 'iam-db', 'database', 'Identity writes', 3, 6),
    relationship('program-store', 'programs', 'programs-db', 'database', 'Program writes', 5, 12),
    relationship(
      'schedule-store',
      'scheduling',
      'scheduling-db',
      'database',
      'Schedule writes',
      4,
      8
    ),
    relationship('iam-programs', 'iam', 'programs', 'event', 'Identity events', 3, 6),
    relationship(
      'programs-scheduling',
      'programs',
      'scheduling',
      'event',
      'Program / period events',
      4,
      12
    ),
    relationship('scheduling-programs', 'scheduling', 'programs', 'event', 'Slot events', 2, 8),
    relationship('dash-iam', 'dash', 'iam', 'http', 'Identity requests', 4, 20),
    relationship('dash-programs', 'dash', 'programs', 'http', 'Program requests', 8, 36),
    relationship('dash-scheduling', 'dash', 'scheduling', 'http', 'Schedule requests', 6, 24),
    relationship('staff-iam', 'staff', 'iam', 'http', 'Admin requests', 6, 3),
    relationship('staff-programs', 'staff', 'programs', 'http', 'Program inspection', 2, 0),
  ];
  const broker = systems.find(s => s.id === 'broker')!;
  broker.summary =
    'Broker infrastructure health. Event edges represent logical paths through this broker; they are not direct HTTP calls.';
  broker.evidence = [
    {
      label: 'Broker scope',
      description:
        'Illustrative broker-wide state. Broker totals cannot be attributed to a particular queue or logical event edge.',
    },
  ];

  if (scenario === 'incident') {
    const scheduling = systems.find(s => s.id === 'scheduling')!;
    scheduling.health = 'critical';
    scheduling.errors = 18;
    scheduling.summary =
      'Fixture incident: scheduling requests are failing. Select the incoming request path to inspect its measurements.';
    const request = relationships.find(r => r.id === 'dash-scheduling')!;
    request.health = 'critical';
    request.latencyMs = 2400;
    request.summary =
      'Fixture incident: p95 request latency is 2.4 seconds and the target reports failures.';
    request.evidence.push({
      label: 'Request measurement',
      description:
        'Invented 5-minute window: 24 requests/second, p95 2,400 ms. A live implementation would link to the matching Datadog query.',
    });
    const projection = relationships.find(r => r.id === 'programs-scheduling')!;
    projection.health = 'warning';
    projection.summary =
      'Fixture warning: consumer processing failures observed. Projection completion and lag remain unmeasured.';
  }

  if (scenario === 'missing') {
    const scheduling = systems.find(s => s.id === 'scheduling')!;
    scheduling.health = 'unknown';
    scheduling.freshness = 'stale';
    scheduling.errors = null;
    scheduling.summary =
      'Fixture coverage gap: the last system observation is stale. This is not a healthy or zero-error reading.';
    for (const edge of relationships.filter(
      r => r.target === 'scheduling' || r.source === 'scheduling'
    )) {
      edge.health = 'unknown';
      edge.freshness = 'missing';
      edge.rate = null;
      edge.latencyMs = null;
      edge.summary =
        'No current observation. The declared relationship remains visible; traffic is unknown, not zero.';
    }
  }

  return {
    topologyVersion: 'vishnu-fixture-v1',
    environment: 'Illustrative mesh',
    mode: 'fixture',
    observedAt: '2026-10-20T12:00:00.000Z',
    observationWindowSeconds: 300,
    systems,
    relationships,
  };
}
