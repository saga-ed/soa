/**
 * Read-only synthetic-dev observations for Vishnu. The manifest supplies declared
 * wiring; probes supply reachability only, never invented traffic or latency.
 * This intentionally does not serialize launch env or database credentials.
 */
import { busRoles } from './mesh-bus-roles.js';
import { httpProtocol } from './mesh-protocols.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { deriveInstance, slotExcludedServices } from '../core/derive-instance.js';
import { manifest } from '../core/manifest/index.js';
import type { ServiceId, MeshId } from '../core/manifest/index.js';
import { makeRealProber, type HealthProber } from './health.js';

type Health = 'healthy' | 'critical' | 'unknown';
interface Evidence {
  label: string;
  description: string;
  url?: string;
}
interface System {
  eventBus?: { publishes: boolean; consumes: boolean };
  id: string;
  label: string;
  band: 'data' | 'mesh' | 'application';
  kind: string;
  health: Health;
  freshness: 'fresh' | 'missing';
  summary: string;
  errors: null;
  evidence: Evidence[];
}
interface Relationship {
  id: string;
  source: string;
  target: string;
  label: string;
  via?: string[];
  kind: 'http' | 'event' | 'database';
  protocol?: 'trpc' | 'rest' | 'mixed' | 'unknown';
  count: null;
  rate: null;
  latencyMs: null;
  health: 'unknown';
  freshness: 'missing';
  summary: string;
  evidence: Evidence[];
}
export interface LocalMeshSnapshot {
  topologyVersion: string;
  environment: string;
  mode: 'live';
  slot: number;
  observedAt: string;
  observationWindowSeconds: number;
  systems: System[];
  relationships: Relationship[];
}
export interface MeshViewOptions {
  slot?: number;
  stateDir?: string;
  prober?: HealthProber;
  tcpProbe?: (port: number) => Promise<boolean>;
  hasPidFile?: (id: ServiceId) => Promise<boolean>;
  now?: () => Date;
}

async function tcpProbe(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * One collector per viewer process. Retaining discovered services makes a
 * stopped process visible as unavailable rather than silently removing its node.
 */
export function createLocalMeshCollector(options: MeshViewOptions = {}) {
  const instance = deriveInstance({ slot: options.slot ?? 0 });
  const stateDir = options.stateDir ?? instance.stateDir;
  const prober = options.prober ?? makeRealProber({ timeoutMs: 1500, followRedirects: false });
  const probeTcp = options.tcpProbe ?? tcpProbe;
  const now = options.now ?? (() => new Date());
  const hasPidFile =
    options.hasPidFile ??
    (async (id: ServiceId) => {
      try {
        await access(join(stateDir, `${id}.pid`));
        return true;
      } catch {
        return false;
      }
    });
  const excluded = new Set(slotExcludedServices(instance.slot));
  const services = Object.values(manifest.services).filter(s => !excluded.has(s.id));
  const retained = new Set<ServiceId>();

  return async (): Promise<LocalMeshSnapshot> => {
    const observedAt = now().toISOString();
    const rows = await Promise.all(
      services.map(async service => {
        const port = instance.portOverrides[service.id] ?? service.port;
        const url = `http://127.0.0.1:${port}${service.healthPath}`;
        const [probe, tracked] = await Promise.all([prober.probe(url), hasPidFile(service.id)]);
        if (probe.ok || tracked) retained.add(service.id);
        return { service, url, probe };
      })
    );
    // Include declared dependencies even when they never started successfully.
    const include = (id: ServiceId) => {
      if (excluded.has(id)) return;
      retained.add(id);
      for (const dep of manifest.services[id].dependsOn) {
        if (!retained.has(dep)) include(dep);
      }
    };
    for (const id of [...retained]) include(id);
    const visible = rows.filter(row => retained.has(row.service.id));
    const systems: System[] = visible.map(({ service, url, probe }) => ({
      id: service.id,
      label: service.id,
      band: service.isFrontend ? 'application' : 'mesh',
      ...(busRoles[service.id] ? { eventBus: { publishes: busRoles[service.id]!.publishes, consumes: busRoles[service.id]!.consumes } } : {}),
      kind: service.isFrontend ? 'Web application' : 'API service',
      health: probe.ok ? 'healthy' : 'critical',
      freshness: 'fresh',
      errors: null,
      summary: probe.ok
        ? 'Local HTTP probe succeeded. This establishes endpoint reachability, not request success rates or end-to-end business health. Process and checkout identity are not verified by this probe; use ss stack verify for that check.'
        : 'Local HTTP probe failed. The declared service remains visible; inspect its ss log and startup state.',
      evidence: [
        ...(busRoles[service.id] ? [{ label: 'Event bus capability (source-verified)', description: busRoles[service.id]!.evidence + ' Declared capability, not observed traffic or consumer health.' }] : []),
        {
          label: 'HTTP health probe',
          description: `GET ${url} — ${probe.status ? `HTTP ${probe.status}` : 'no HTTP response'}. Observed ${observedAt}.`,
          url,
        },
        {
          label: 'Declared service',
          description: `ss manifest: ${service.id}, repo ${service.repo}. Slot ${instance.slot}. No production service queried.`,
        },
      ],
    }));
    const relationships: Relationship[] = [];
    const add = (
      id: string,
      source: string,
      target: string,
      kind: Relationship['kind'],
      label: string,
      description: string
    ) => {
      relationships.push({
        id,
        source,
        target,
        kind,
        ...(kind === 'http' ? { protocol: httpProtocol(source, target).protocol } : {}),
        label,
        ...(kind === 'event' ? { via: ['infra:rabbitmq'] } : {}),
        count: null,
        rate: null,
        latencyMs: null,
        health: 'unknown',
        freshness: 'missing',
        summary: `${description} This is declared wiring, not an observed request or event. Traffic, endpoint/event count, and projection completion are not measured.`,
        evidence: [{ label: 'ss service manifest', description }, ...(kind === 'http' ? [{ label: 'Client transport evidence', description: httpProtocol(source, target).evidence }] : [])],
      });
    };
    const meshIds = new Set<MeshId>();
    for (const { service } of visible) {
      for (const unit of service.mesh) meshIds.add(unit);
      for (const dep of service.dependsOn) {
        if (!retained.has(dep)) continue;
        const kind = service.depKinds[dep];
        if (kind === 'event') {
          add(
            `dep:${dep}:${service.id}`,
            dep,
            service.id,
            'event',
            `${dep} events`,
            `${service.id} declares an event dependency on ${dep}, via RabbitMQ. Exact bindings are not represented in the ss manifest.`
          );
        } else {
          add(
            `dep:${service.id}:${dep}`,
            service.id,
            dep,
            'http',
            `${service.id} → ${dep}`,
            `${service.id} declares a ${kind ?? 'runtime'} dependency on ${dep}.`
          );
        }
      }
      for (const db of service.databases) {
        const unit: MeshId =
          manifest.databases[db].engine === 'mongo' ? 'connect-mongo' : 'postgres';
        meshIds.add(unit);
        add(
          `db:${service.id}:${db}`,
          service.id,
          `infra:${unit}`,
          'database',
          db,
          `${service.id} uses the ${db} database. The store node measures TCP reachability only; database authentication and schema are not probed.`
        );
      }
      if (service.mesh.includes('redis')) {
        add(
          `cache:${service.id}`,
          service.id,
          'infra:redis',
          'database',
          'Redis connection',
          `${service.id} declares a Redis dependency.`
        );
      }
      if (service.mesh.includes('openfga')) {
        add(
          `authz:${service.id}`,
          service.id,
          'infra:openfga',
          'http',
          'OpenFGA connection',
          `${service.id} declares an OpenFGA infrastructure dependency.`
        );
      }
    }
    for (const unit of await Promise.all(
      [...meshIds].sort().map(async id => {
        const def = manifest.mesh[id];
        const port = def.port + instance.offset;
        return { id, port, ok: await probeTcp(port) };
      })
    )) {
      systems.push({
        id: `infra:${unit.id}`,
        label: unit.id,
        band: unit.id === 'rabbitmq' ? 'mesh' : 'data',
        kind: 'Infrastructure listener',
        health: unit.ok ? 'healthy' : 'critical',
        freshness: 'fresh',
        errors: null,
        summary: unit.ok
          ? `TCP listener on port ${unit.port} is reachable. Protocol readiness, database contents, queue depths, and traffic have not been measured.`
          : `TCP listener on port ${unit.port} is not reachable.`,
        evidence: [
          {
            label: 'TCP reachability',
            description: `127.0.0.1:${unit.port}, slot ${instance.slot}, observed ${observedAt}. No credentials or database records are returned.`,
          },
          ...(unit.id === 'rabbitmq'
            ? [
                {
                  label: 'Logical event paths',
                  description:
                    'Event edges represent publisher-to-consumer dependencies through this broker. Select relationship details to inspect those paths; queue bindings and delivery are not independently verified.',
                },
              ]
            : []),
        ],
      });
    }
    systems.sort((a, b) => a.id.localeCompare(b.id));
    relationships.sort((a, b) => a.id.localeCompare(b.id));
    return {
      mode: 'live',
      slot: instance.slot,
      environment: 'synthetic-dev',
      topologyVersion: JSON.stringify({
        nodes: systems.map(s => s.id),
        edges: relationships.map(r => [r.id, r.source, r.target]),
      }),
      observedAt,
      observationWindowSeconds: 0,
      systems,
      relationships,
    };
  };
}
