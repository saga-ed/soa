/**
 * launchOrder — Kahn topological waves over the manifest `dependsOn` graph.
 *
 * PURE: zero IO. Given a set of services, returns the launch *waves* — each
 * wave is a group of services whose in-graph dependencies are already
 * satisfied by an earlier wave, so the launcher may boot a wave in parallel
 * and must boot earlier waves first. `event`/`browser` edges count the same as
 * `url`/`s2s` for ORDER (producer before consumer); the health-gating
 * distinction (events may be non-blocking) lives in the runtime layer, not
 * here.
 *
 * Edges to services OUTSIDE the supplied set are ignored — `launchOrder` orders
 * exactly the set it is given (typically a `computeClosure` result), so a
 * partial stack is ordered against only the services that are actually present.
 */

import { manifest } from './manifest/index.js';
import type { Manifest, ServiceId } from './manifest/index.js';

/**
 * Topologically order `services` into launch waves over `m.dependsOn`.
 *
 * Within a wave, services keep the manifest's declaration order so the output
 * is deterministic. Throws on an unknown id or a dependency cycle.
 */
export function launchOrder(services: ServiceId[], m: Manifest = manifest): ServiceId[][] {
  const set = new Set<ServiceId>();
  for (const s of services) {
    if (!m.services[s]) throw new Error(`unknown service id: ${s}`);
    set.add(s);
  }

  // Manifest declaration order — used to keep each wave deterministic.
  const declOrder = (Object.keys(m.services) as ServiceId[]).filter((s) => set.has(s));

  const done = new Set<ServiceId>();
  const waves: ServiceId[][] = [];

  while (done.size < set.size) {
    // A service is ready when every in-set dependency has already launched.
    const wave = declOrder.filter((s) => {
      if (done.has(s)) return false;
      const def = m.services[s];
      // Unreachable: declOrder ⊆ set ⊆ validated ids — guard satisfies the type.
      if (!def) return false;
      return def.dependsOn.every((dep) => !set.has(dep) || done.has(dep));
    });
    if (wave.length === 0) {
      const remaining = declOrder.filter((s) => !done.has(s));
      throw new Error(`cycle detected in service dependsOn graph among: ${remaining.join(', ')}`);
    }
    waves.push(wave);
    for (const s of wave) done.add(s);
  }

  return waves;
}
