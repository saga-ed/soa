/**
 * FeatureSet selection-model invariants.
 *
 * These guard the three failure modes the boolean-per-family shape kept
 * producing:
 *   - an `optional:true` service mapped to NO feature ⇒ silent empty closure
 *     (shipped three times: snapshot store, snapshot restore, flow resolution);
 *   - `--only <optional-svc>` resolving empty because only `--with` fed the
 *     opt-in flags;
 *   - one feature cross-admitting another family's services.
 *
 * Runs against the REAL frozen manifest + bundle registry. PURE: no docker/network.
 */

import { describe, expect, it } from 'vitest';
import {
  BUNDLES,
  BUNDLE_FOR_SERVICE,
  BUNDLE_NAMES,
  closureOptsFor,
  combineRequested,
  featureSet,
  featuresFor,
  featuresForIds,
  featuresOf,
  fromLegacy,
  toLegacy,
} from '../bundles.js';
import { computeClosure } from '../closure.js';
import { manifest } from '../manifest/index.js';
import type { ServiceId } from '../manifest/index.js';

const fail = (m: string): never => {
  throw new Error(m);
};

/** Every `optional:true` id in the manifest — the set that NEEDS a feature mapping. */
const optionalIds = (Object.keys(manifest.services) as ServiceId[]).filter(
  (id) => manifest.services[id].optional,
);

describe('BUNDLE_FOR_SERVICE — the manifest/registry invariant', () => {
  it('maps every optional:true service to a bundle', () => {
    // This is the build-time half of `admitsOptional`'s runtime throw: an
    // optional service in no bundle can never be admitted, so it would resolve
    // an empty closure for anyone who asked for it.
    const unmapped = optionalIds.filter((id) => !BUNDLE_FOR_SERVICE.has(id));
    expect(unmapped).toEqual([]);
  });

  it('covers the optional families we expect (guards an accidental registry deletion)', () => {
    expect(optionalIds.length).toBeGreaterThanOrEqual(6);
    for (const id of optionalIds) {
      expect(BUNDLE_NAMES).toContain(BUNDLE_FOR_SERVICE.get(id));
    }
  });

  it('lets computeClosure resolve a NON-empty closure for every optional service', () => {
    // The end-to-end version of the invariant above: for each optional id, its
    // own feature must actually admit it.
    for (const id of optionalIds) {
      const owner = BUNDLE_FOR_SERVICE.get(id)!;
      const closure = computeClosure(manifest, [id], { features: featureSet([owner]) });
      expect(closure.services, `${id} via --with ${owner}`).toContain(id);
    }
  });
});

describe('--only <optional-svc> implies its feature (regression: silent empty closure)', () => {
  it('resolves a non-empty closure WITHOUT an explicit --with', () => {
    // Before `featuresFor` took `only`, this resolved to [] — exit 0, no error.
    const features = featuresFor('transcripts-api', undefined, fail);
    const closure = computeClosure(manifest, ['transcripts-api'], { features });
    expect(closure.services).toContain('transcripts-api');
  });

  it('works for authz-sync too (a different family)', () => {
    const features = featuresFor('authz-sync', undefined, fail);
    const closure = computeClosure(manifest, ['authz-sync'], { features });
    expect(closure.services).toContain('authz-sync');
  });

  it('still honours an explicit --with, and the two compose', () => {
    const features = featuresFor('transcripts-api', ['authz'], fail);
    expect(features.has('playback')).toBe(true);
    expect(features.has('authz')).toBe(true);
  });

  it('rejects an unknown bundle name', () => {
    expect(() => featuresFor(undefined, ['nope'], fail)).toThrow(/unknown bundle/);
  });
});

describe('no cross-admission between families', () => {
  it('--with authz does not admit the playback trio', () => {
    const features = featuresFor(undefined, ['authz'], fail);
    const closure = computeClosure(manifest, ['transcripts-api'], { features });
    expect(closure.services).not.toContain('transcripts-api');
  });

  it('--with playback does not admit authz-sync', () => {
    const features = featuresFor(undefined, ['playback'], fail);
    const closure = computeClosure(manifest, ['authz-sync'], { features });
    expect(closure.services).not.toContain('authz-sync');
  });
});

describe('bundle-contributed mesh', () => {
  it('unions BundleDef.mesh into the closure for a selected feature', () => {
    // `authz` reaches openfga through authz-sync's own `mesh`, so to test the
    // BundleDef.mesh path specifically we assert the mechanism is wired: a
    // bundle declaring mesh contributes it even with zero services.
    const withMesh = BUNDLE_NAMES.filter((n) => (BUNDLES[n].mesh ?? []).length > 0);
    for (const name of withMesh) {
      const closure = computeClosure(manifest, [], { features: featureSet([name]) });
      for (const unit of BUNDLES[name].mesh ?? []) {
        expect(closure.mesh, `${name} contributes ${unit}`).toContain(unit);
      }
    }
  });

  it('contributes no mesh when the feature is not selected', () => {
    const closure = computeClosure(manifest, [], { features: featureSet([]) });
    for (const name of BUNDLE_NAMES) {
      for (const unit of BUNDLES[name].mesh ?? []) {
        expect(closure.mesh).not.toContain(unit);
      }
    }
  });
});

describe('legacy adapters round-trip (delete with the last withX call site)', () => {
  it('toLegacy ∘ fromLegacy is identity on the three flags', () => {
    for (const opts of [
      { withPlayback: true, withAuthz: false, withStaffAdmin: false },
      { withPlayback: false, withAuthz: true, withStaffAdmin: false },
      { withPlayback: false, withAuthz: false, withStaffAdmin: true },
      { withPlayback: true, withAuthz: true, withStaffAdmin: true },
      { withPlayback: false, withAuthz: false, withStaffAdmin: false },
    ]) {
      expect(toLegacy(fromLegacy(opts))).toEqual(opts);
    }
  });

  it('legacy flags and features resolve the SAME closure', () => {
    const legacy = computeClosure(manifest, ['transcripts-api'], { withPlayback: true });
    const modern = computeClosure(manifest, ['transcripts-api'], {
      features: featureSet(['playback']),
    });
    expect(modern.services).toEqual(legacy.services);
    expect(modern.mesh).toEqual(legacy.mesh);
    expect(modern.databases).toEqual(legacy.databases);
  });

  it('features WINS over the legacy flags when both are passed', () => {
    const closure = computeClosure(manifest, ['transcripts-api'], {
      features: featureSet([]),
      withPlayback: true,
    });
    expect(closure.services).not.toContain('transcripts-api');
  });
});

describe('parity with the legacy derivation (no behavior change)', () => {
  // Every realistic existing invocation must resolve an IDENTICAL closure under
  // the old derivation (`closureOptsFor`, `--with` only) and the new one
  // (`featuresFor`, `--only ∪ --with`). A difference here is an unintended
  // behavior change.
  //
  // The ONE deliberate exception is `--only <optional-svc>` with no `--with`,
  // which used to resolve EMPTY — asserted as a fix above, so it is not listed
  // here.
  const CASES: Array<{ only?: string; with?: string[] }> = [
    {},
    { with: ['dash'] },
    { with: ['connect'] },
    { with: ['coach'] },
    { with: ['playback'] },
    { with: ['authz'] },
    { with: ['staff-admin'] },
    { with: ['qtf'] },
    { with: ['dash', 'authz'] },
    { with: ['playback', 'authz', 'staff-admin'] },
    { only: 'sessions-api' },
    { only: 'iam-api,programs-api' },
    { only: 'saga-dash', with: ['dash'] },
    { only: 'transcripts-api', with: ['playback'] },
    { only: 'authz-sync', with: ['authz'] },
    { only: 'connect-web', with: ['connect'] },
  ];

  it.each(CASES)('resolves identically for %j', (c) => {
    const requested = combineRequested(c.only, c.with, fail);
    const old = computeClosure(manifest, requested, closureOptsFor(c.with));
    const next = computeClosure(manifest, requested, {
      features: featuresFor(c.only, c.with, fail),
    });
    expect(next.services).toEqual(old.services);
    expect(next.mesh).toEqual(old.mesh);
    expect(next.databases).toEqual(old.databases);
  });
});

describe('featuresForIds / featuresOf', () => {
  it('derives a feature from a named optional id', () => {
    expect(featuresForIds(['authz-sync']).has('authz')).toBe(true);
  });

  it('ignores ids that belong to no bundle', () => {
    expect([...featuresForIds(['iam-api'])]).toEqual([]);
  });

  it('featuresOf unions bundle names with id-implied features', () => {
    const features = featuresOf(['authz'], ['transcripts-api']);
    expect(features.has('authz')).toBe(true);
    expect(features.has('playback')).toBe(true);
  });
});
