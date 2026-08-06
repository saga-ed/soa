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
 * `optional:true` services — the playback trio, `authz-sync`, the staff-admin
 * pair — are kept ONLY when `opts.features` selects the bundle that owns them.
 * Nothing in the graph `dependsOn` them, so this gate is the only thing that
 * admits them, and a requested optional service is dropped (not launched)
 * otherwise. Each maps to its OWN bundle (see `admitsOptional` below): a blanket
 * "any feature selected" test would cross-admit, e.g. `--only transcripts-api
 * --with authz` would wrongly resolve transcripts-api.
 */

import { BUNDLE_FOR_SERVICE, BUNDLES, featureSet, type FeatureSet } from './bundles.js';
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
  /**
   * The features selected for this run. Omitted ⇒ no `optional:true` service is
   * admitted; mint one with `featureSet()` / `featuresFor()` in bundles.ts.
   */
  features?: FeatureSet;
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
  const features = opts.features ?? featureSet([]);
  const followBrowserEdges = opts.followBrowserEdges ?? true;

  // Each optional service is admitted by its OWN feature — never a blanket OR of
  // every selected feature, which would cross-admit (e.g. `--with authz` alone
  // must not also resolve the playback trio). Membership comes from
  // `BUNDLE_FOR_SERVICE`, inverted from BUNDLES, so adding a family is a registry
  // edit and no code change here. Importing bundles.ts is safe: its only
  // dependency on this module is `import type { ClosureOpts }`, erased at compile
  // time — there is no runtime cycle.
  //
  // EXHAUSTIVE BY CONSTRUCTION: there is deliberately no permissive fallthrough.
  // The original `return withPlayback` default silently handed every unmapped
  // optional id the playback flag, so a newly-added optional service resolved an
  // EMPTY closure (exit 0, no error) until someone noticed. An unmapped id THROWS.
  // A manifest invariant test also asserts every `optional:true` id is mapped, so
  // this throw is the belt to that test's braces.
  const admitsOptional = (id: ServiceId): boolean => {
    const owner = BUNDLE_FOR_SERVICE.get(id);
    if (!owner) {
      throw new Error(
        `closure: optional service '${id}' belongs to no BUNDLES entry — add it to one, ` +
          `or it will silently resolve an empty closure.`,
      );
    }
    return features.has(owner);
  };

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

  // Mesh units a selected FEATURE brings up directly, independent of any service
  // (BundleDef.mesh). Without this a unit can only be gated by hanging it off an
  // `optional:true` service, which is impossible for one wanted by an
  // `optional:false` service — see the BundleDef.mesh docs.
  for (const name of features) {
    for (const u of BUNDLES[name].mesh ?? []) meshSet.add(u);
  }

  const databases = (Object.keys(m.databases) as DbId[]).filter((d) => dbSet.has(d));
  const mesh = (Object.keys(m.mesh) as MeshId[]).filter((u) => meshSet.has(u));

  const services = launchOrder([...inClosure], m).flat();

  return { services, databases, mesh, reasons };
}
