/**
 * computeClosure — the N-of-M dependency-closure engine (plan §2.3).
 *
 * PURE: zero IO. Given the manifest and a set of requested services, BFS the
 * transitive closure over `dependsOn`, union the services' databases + mesh
 * units, topo-order the services into launch order, and record WHY each
 * pulled-in service is present.
 *
 *   computeClosure(m, ['scheduling-api','sessions-api'])
 *     ⇒ services {iam-api, programs-api, scheduling-api, sessions-api}
 *        databases {iam_local, iam_pii_local, programs, scheduling, sessions}
 *        mesh {postgres, rabbitmq}            // mongo dropped — no connect-api
 *
 * Two manifest-derived rules fall out for free from the union:
 *  - `connect-mongo` (mesh) is reached only via `connect-api.mesh`, so a closure
 *    without connect-api never includes it.
 *  - `connectv3` (db) is reached only via `connect-api.databases`, likewise.
 *
 * Playback (`optional:true`) services — transcripts/insights/chat — are kept
 * ONLY when `opts.withPlayback` is set. Nothing in the graph `dependsOn` them,
 * so this gate is the only thing that admits them, and a requested playback
 * service is dropped (not launched) unless `--with-playback` is passed.
 *
 * `authz-sync` (`optional:true`) is the same shape, gated by `opts.withAuthz`
 * instead. Each optional service maps to its OWN opt-in flag (see
 * `admitsOptional` below) — a bare `withPlayback || withAuthz` OR would let
 * either flag admit BOTH families (e.g. `--only transcripts-api --with authz`
 * would wrongly resolve transcripts-api), so the gate dispatches per service id.
 */

import { launchOrder } from './launch-order.js';
import type { DbId, Manifest, MeshId, ServiceId } from './manifest/index.js';

export interface Closure {
  /** Services in topo-ordered launch order (waves flattened, declaration-stable). */
  services: ServiceId[];
  /** Migrate/seed targets — union of the closure services' databases. */
  databases: DbId[];
  /** Mesh units the closure needs — union of the closure services' mesh. */
  mesh: MeshId[];
  /** Why each service is in the closure: 'requested' and/or `required by <svc> (<kind>)`. */
  reasons: Map<ServiceId, string[]>;
}

export interface ClosureOpts {
  /** Keep `optional:true` playback services (transcripts/insights/chat). */
  withPlayback?: boolean;
  /** Keep the `optional:true` `authz-sync` service. */
  withAuthz?: boolean;
  /**
   * Whether to traverse `depKind: 'browser'` edges (default `true`).
   *
   * A `browser` edge means a frontend MAY call that backend from SOME page — so
   * for interactive `stack up --only saga-dash` we follow them and bring the
   * whole stack up. But an e2e FLOW only exercises specific stages, which list
   * the backends they actually touch in `requiredSystems`; for those, following
   * saga-dash's browser edges would drag in every backend and defeat the N-of-M
   * payoff (plan §5.2 — "content-api is in no journey stage → never launched").
   * Flow resolution therefore passes `false`: the flow's explicit requiredSystems
   * drive the launch set, expanding only their hard (url/s2s/event) deps.
   */
  followBrowserEdges?: boolean;
}

/**
 * Compute the transitive `dependsOn` closure of `requested` over the manifest.
 * Throws on an unknown requested service id.
 */
export function computeClosure(
  m: Manifest,
  requested: ServiceId[],
  opts: ClosureOpts = {},
): Closure {
  const withPlayback = opts.withPlayback ?? false;
  const withAuthz = opts.withAuthz ?? false;
  const followBrowserEdges = opts.followBrowserEdges ?? true;

  // Each optional service is admitted by its OWN flag — never a blanket OR of
  // every opt-in flag, which would cross-admit (e.g. `--with authz` alone must
  // not also resolve the playback trio).
  const admitsOptional = (id: ServiceId): boolean =>
    id === 'authz-sync' || id === 'authz-api' ? withAuthz : withPlayback;

  const inClosure = new Set<ServiceId>();
  const reasons = new Map<ServiceId, string[]>();
  const queue: ServiceId[] = [];

  const addReason = (id: ServiceId, why: string): void => {
    const arr = reasons.get(id);
    if (arr) {
      if (!arr.includes(why)) arr.push(why);
    } else {
      reasons.set(id, [why]);
    }
  };

  const enqueue = (id: ServiceId): void => {
    if (!inClosure.has(id)) {
      inClosure.add(id);
      queue.push(id);
    }
  };

  // Seed the BFS with the requested services (playback admitted only on opt-in).
  for (const id of requested) {
    const def = m.services[id];
    if (!def) throw new Error(`unknown service id: ${id}`);
    if (def.optional && !admitsOptional(id)) continue;
    addReason(id, 'requested');
    enqueue(id);
  }

  // BFS over dependsOn, recording the edge that pulled each dependency in.
  while (queue.length > 0) {
    const id = queue.shift() as ServiceId;
    const def = m.services[id];
    // Unreachable: ids reach the queue only after validation — guard for the type.
    if (!def) continue;
    for (const dep of def.dependsOn) {
      const depDef = m.services[dep];
      if (!depDef) throw new Error(`unknown service id: ${dep}`);
      if (depDef.optional && !admitsOptional(dep)) continue;
      const kind = def.depKinds[dep] ?? 'url';
      // Skip browser edges when narrowing a flow closure (see followBrowserEdges).
      if (kind === 'browser' && !followBrowserEdges) continue;
      addReason(dep, `required by ${id} (${kind})`);
      enqueue(dep);
    }
  }

  // Union databases + mesh, ordered by manifest declaration order for determinism.
  const dbSet = new Set<DbId>();
  const meshSet = new Set<MeshId>();
  for (const id of inClosure) {
    const def = m.services[id];
    if (!def) continue;
    for (const d of def.databases) dbSet.add(d);
    for (const u of def.mesh) meshSet.add(u);
  }

  const databases = (Object.keys(m.databases) as DbId[]).filter((d) => dbSet.has(d));
  const mesh = (Object.keys(m.mesh) as MeshId[]).filter((u) => meshSet.has(u));

  const services = launchOrder([...inClosure], m).flat();

  return { services, databases, mesh, reasons };
}
