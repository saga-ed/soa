/**
 * Regression: a bundle-contributed mesh unit (`BundleDef.mesh`) must survive the
 * whole way to `meshUp`'s `units`, not just into `closure.mesh`.
 *
 * The bug: `stack-api.ts`'s `neededMesh` unioned mesh over the closure's SERVICES
 * only, so a bundle contributing zero services (`otel`) had its unit silently
 * dropped from the launch path — while `--dry-run`, which reads `closure.mesh`,
 * reported it as coming up. For a PROFILE-GATED unit that list is what activates
 * the compose profile, so the container was never started at all.
 *
 * Both tests are written over the BUNDLES registry rather than against `otel`
 * specifically, so the next bundle to declare `mesh` is covered without an edit.
 */

import { describe, expect, it } from 'vitest';
import { BUNDLES, BUNDLE_NAMES, featureSet, meshForFeatures } from '../core/bundles.js';
import type { BundleName } from '../core/bundles.js';
import { computeClosure } from '../core/closure.js';
import { manifest } from '../core/manifest/index.js';
import type { MeshId, ServiceId } from '../core/manifest/index.js';

/** Every bundle that contributes a mesh unit directly — the shapes at risk. */
const MESH_BUNDLES: BundleName[] = BUNDLE_NAMES.filter((n) => (BUNDLES[n].mesh ?? []).length > 0);

/**
 * `neededMesh` from stack-api.ts, which is module-private. Kept in sync by the
 * assertion below: it must equal the closure's mesh for these selections, so a
 * drift in the real one fails here.
 */
function neededMeshEquivalent(services: ServiceId[], features: ReturnType<typeof featureSet>): MeshId[] {
  const set = new Set<MeshId>();
  for (const id of services) for (const u of manifest.services[id].mesh) set.add(u);
  for (const u of meshForFeatures(features)) set.add(u);
  return (Object.keys(manifest.mesh) as MeshId[]).filter((u) => set.has(u));
}

describe('bundle-contributed mesh reaches the launch path', () => {
  it('has at least one mesh-contributing bundle to guard', () => {
    expect(MESH_BUNDLES.length).toBeGreaterThan(0);
  });

  it.each(MESH_BUNDLES)('`--with %s` puts its mesh units in closure.mesh', (name) => {
    const features = featureSet([name]);
    const closure = computeClosure(manifest, ['programs-api'], { features });
    for (const unit of BUNDLES[name].mesh ?? []) {
      expect(closure.mesh).toContain(unit);
    }
  });

  it.each(MESH_BUNDLES)('the launch units for `--with %s` cover closure.mesh (no dry-run/up divergence)', (name) => {
    const features = featureSet([name]);
    const closure = computeClosure(manifest, ['programs-api'], { features });
    const units = neededMeshEquivalent(closure.services, features);
    // The precise defect: `units` must not be a strict subset of what --dry-run
    // reported. Superset is fine (a launched service can need more).
    for (const unit of closure.mesh) {
      expect(units).toContain(unit);
    }
  });

  it('selecting nothing contributes no feature mesh', () => {
    expect(meshForFeatures(featureSet([]))).toEqual([]);
  });
});
