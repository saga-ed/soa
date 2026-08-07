/**
 * `meshForFeatures` — the SHARED feature→mesh union, over the BUNDLES registry
 * rather than `otel` specifically, so the next bundle to declare `BundleDef.mesh`
 * is covered without an edit.
 *
 * ⚠️ Scope: this file covers the shared helper and `closure.mesh` (what
 * `--dry-run` reports). The other half — that the LAUNCH path passes the same
 * units to `meshUp`, which is what activates a profile-gated container — is
 * pinned in `stack-api.unit.test.ts` by driving the real `api.up` and asserting
 * `COMPOSE_PROFILES`. It cannot be asserted here: `neededMesh` is module-private,
 * and a reimplementation of it in this file would pass while the real one broke.
 */

import { describe, expect, it } from 'vitest';
import { BUNDLES, BUNDLE_NAMES, featureSet, meshForFeatures } from '../core/bundles.js';
import type { BundleName } from '../core/bundles.js';
import { computeClosure } from '../core/closure.js';
import { manifest } from '../core/manifest/index.js';
import type { ServiceId } from '../core/manifest/index.js';

/** Every bundle that contributes a mesh unit directly — the shapes at risk. */
const MESH_BUNDLES: BundleName[] = BUNDLE_NAMES.filter((n) => (BUNDLES[n].mesh ?? []).length > 0);

describe('bundle-contributed mesh', () => {
  it('has at least one mesh-contributing bundle to guard', () => {
    expect(MESH_BUNDLES.length).toBeGreaterThan(0);
  });

  it.each(MESH_BUNDLES)('`--with %s` puts its mesh units in closure.mesh', (name) => {
    const features = featureSet([name]);
    const closure = computeClosure(manifest, ['programs-api'] as ServiceId[], { features });
    for (const unit of BUNDLES[name].mesh ?? []) {
      expect(closure.mesh).toContain(unit);
    }
  });

  it.each(MESH_BUNDLES)('`--with %s` contributes its units independently of any service', (name) => {
    // The property that makes a service-only union wrong: these units are reachable
    // through the feature alone, so a bundle with `services: []` still yields mesh.
    expect(meshForFeatures(featureSet([name]))).toEqual([...(BUNDLES[name].mesh ?? [])]);
  });

  it('selecting nothing contributes no feature mesh', () => {
    expect(meshForFeatures(featureSet([]))).toEqual([]);
  });
});
