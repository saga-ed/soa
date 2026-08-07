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
  bundleForDb,
  combineRequested,
  featureSet,
  featuresFor,
  featuresForIds,
  featuresOf,
  meshForFeatures,
} from '../bundles.js';
import { computeClosure } from '../closure.js';
import { manifest } from '../manifest/index.js';
import type { DbId, ServiceId } from '../manifest/index.js';

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

  it('maps every opt-in (meshProvisioned:false) DB to a bundle', () => {
    // The db-level twin, guarding `reset`/`snapshot store`: both gate an opt-in
    // db on `bundleForDb`, and a db owned by NO bundle resolves to `undefined`
    // and is silently skipped — a db that never resets, or a snapshot that omits
    // a db while restore still reports success. An unmapped entry must fail
    // HERE, at registry level, rather than degrading quietly at runtime.
    const optIn = (Object.keys(manifest.databases) as DbId[]).filter(
      (db) => !manifest.databases[db].meshProvisioned,
    );
    expect(optIn.length).toBeGreaterThan(0);
    expect(optIn.filter((db) => bundleForDb(db, manifest) === undefined)).toEqual([]);
  });

  it('does NOT map authz_local to a bundle — it is unconditional, not opt-in', () => {
    // authz_local shares the `authz` prefix but belongs to authz-api, a hard
    // sessions-api dependency (soa#402), NOT the `--with authz` OpenFGA opt-in.
    // `meshProvisioned:true` keeps it out of both gates structurally; this pins
    // that a name-keyed sweep would have swept it in.
    expect(manifest.databases.authz_local.meshProvisioned).toBe(true);
    expect(bundleForDb('authz_local', manifest)).toBeUndefined();
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

  // `meshForFeatures` is the SHARED half: `computeClosure` (asserted above, what
  // `--dry-run` reports) and the launch path's `neededMesh` (what starts the
  // container) must both route through it. The launch-path half is pinned in
  // `stack-api.unit.test.ts`, which drives the real `api.up` and asserts
  // `COMPOSE_PROFILES` — it cannot be asserted here, since `neededMesh` is
  // module-private and a reimplementation of it would pass while the real one broke.
  it("meshForFeatures yields a bundle's units independently of any service", () => {
    for (const name of BUNDLE_NAMES) {
      expect(meshForFeatures(featureSet([name]))).toEqual([...(BUNDLES[name].mesh ?? [])]);
    }
  });

  it('meshForFeatures yields nothing when no feature is selected', () => {
    expect(meshForFeatures(featureSet([]))).toEqual([]);
  });
});

describe('characterization: what each realistic invocation resolves', () => {
  // FROZEN EXPECTATIONS, captured from the pre-FeatureSet derivation. These
  // started as an old-vs-new parity assertion, but that form called the legacy
  // producer — so deleting the legacy path would have deleted the proof that
  // deleting it was safe. Literals outlive the code path they were taken from.
  //
  // A diff here is a real closure change: re-derive it deliberately, don't
  // re-bless the literal.
  //
  // `--only <optional-svc>` with no `--with` is absent on purpose — it used to
  // resolve EMPTY, and the fix is asserted as a fix above.
  const CASES: Array<{
    only?: string;
    with?: string[];
    services: string[];
    mesh: string[];
    databases: string[];
  }> = [
    { services: [], mesh: [], databases: [] },
    {
      with: ['dash'],
      services: [
        'iam-api',
        'sis-api',
        'authz-api',
        'programs-api',
        'scheduling-api',
        'content-api',
        'sessions-api',
        'ads-adm-api',
        'saga-dash',
      ],
      mesh: ['postgres', 'redis', 'rabbitmq'],
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'scheduling',
        'sessions',
        'content',
        'sis_db',
        'ads_adm_local',
        'ledger_local',
        'authz_local',
      ],
    },
    {
      with: ['connect'],
      services: [
        'iam-api',
        'rtsm-api',
        'authz-api',
        'programs-api',
        'scheduling-api',
        'content-api',
        'sessions-api',
        'connect-api',
        'connect-web',
      ],
      mesh: ['postgres', 'redis', 'rabbitmq', 'connect-mongo'],
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'scheduling',
        'sessions',
        'content',
        'connectv3',
        'authz_local',
      ],
    },
    {
      with: ['coach'],
      services: ['iam-api', 'programs-api', 'coach-api', 'coach-web'],
      mesh: ['postgres', 'redis', 'rabbitmq'],
      databases: ['iam_local', 'iam_pii_local', 'programs', 'coach_api'],
    },
    {
      with: ['playback'],
      services: ['transcripts-api', 'insights-api', 'chat-api'],
      mesh: ['postgres'],
      databases: ['transcripts_local', 'insights_local', 'chat_local'],
    },
    {
      with: ['authz'],
      services: ['authz-sync'],
      mesh: ['postgres', 'rabbitmq', 'openfga'],
      databases: ['openfga', 'authz_sync_local'],
    },
    {
      with: ['staff-admin'],
      services: ['iam-api', 'sis-api', 'programs-api', 'staff-admin-bff', 'staff-admin-console'],
      mesh: ['postgres', 'redis', 'rabbitmq'],
      databases: ['iam_local', 'iam_pii_local', 'programs', 'sis_db'],
    },
    // qtf contributes no services (it is a mesh-only bundle) — an empty closure
    // here is correct, not the empty-closure bug.
    { with: ['qtf'], services: [], mesh: [], databases: [] },
    {
      with: ['dash', 'authz'],
      services: [
        'iam-api',
        'authz-sync',
        'sis-api',
        'authz-api',
        'programs-api',
        'scheduling-api',
        'content-api',
        'sessions-api',
        'ads-adm-api',
        'saga-dash',
      ],
      mesh: ['postgres', 'redis', 'rabbitmq', 'openfga'],
      // Both `authz_local` (unconditional, authz-api's) AND the opt-in pair
      // (`openfga`/`authz_sync_local`) — the distinction soa#402 introduced.
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'scheduling',
        'sessions',
        'content',
        'sis_db',
        'ads_adm_local',
        'ledger_local',
        'openfga',
        'authz_sync_local',
        'authz_local',
      ],
    },
    {
      with: ['playback', 'authz', 'staff-admin'],
      services: [
        'iam-api',
        'transcripts-api',
        'insights-api',
        'chat-api',
        'authz-sync',
        'sis-api',
        'programs-api',
        'staff-admin-bff',
        'staff-admin-console',
      ],
      mesh: ['postgres', 'redis', 'rabbitmq', 'openfga'],
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'sis_db',
        'transcripts_local',
        'insights_local',
        'chat_local',
        'openfga',
        'authz_sync_local',
      ],
    },
    {
      only: 'sessions-api',
      services: ['iam-api', 'authz-api', 'programs-api', 'scheduling-api', 'sessions-api'],
      mesh: ['postgres', 'redis', 'rabbitmq'],
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'scheduling',
        'sessions',
        'authz_local',
      ],
    },
    {
      only: 'iam-api,programs-api',
      services: ['iam-api', 'programs-api'],
      mesh: ['postgres', 'redis', 'rabbitmq'],
      databases: ['iam_local', 'iam_pii_local', 'programs'],
    },
    {
      only: 'saga-dash',
      with: ['dash'],
      services: [
        'iam-api',
        'sis-api',
        'authz-api',
        'programs-api',
        'scheduling-api',
        'content-api',
        'sessions-api',
        'ads-adm-api',
        'saga-dash',
      ],
      mesh: ['postgres', 'redis', 'rabbitmq'],
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'scheduling',
        'sessions',
        'content',
        'sis_db',
        'ads_adm_local',
        'ledger_local',
        'authz_local',
      ],
    },
    {
      only: 'transcripts-api',
      with: ['playback'],
      services: ['transcripts-api', 'insights-api', 'chat-api'],
      mesh: ['postgres'],
      databases: ['transcripts_local', 'insights_local', 'chat_local'],
    },
    {
      only: 'authz-sync',
      with: ['authz'],
      services: ['authz-sync'],
      mesh: ['postgres', 'rabbitmq', 'openfga'],
      databases: ['openfga', 'authz_sync_local'],
    },
    {
      only: 'connect-web',
      with: ['connect'],
      services: [
        'iam-api',
        'rtsm-api',
        'authz-api',
        'programs-api',
        'scheduling-api',
        'content-api',
        'sessions-api',
        'connect-api',
        'connect-web',
      ],
      mesh: ['postgres', 'redis', 'rabbitmq', 'connect-mongo'],
      databases: [
        'iam_local',
        'iam_pii_local',
        'programs',
        'scheduling',
        'sessions',
        'content',
        'connectv3',
        'authz_local',
      ],
    },
  ];

  it.each(CASES)('resolves the frozen closure for %j', (c) => {
    const requested = combineRequested(c.only, c.with, fail);
    const closure = computeClosure(manifest, requested, {
      features: featuresFor(c.only, c.with, fail),
    });
    expect(closure.services).toEqual(c.services);
    expect(closure.mesh).toEqual(c.mesh);
    expect(closure.databases).toEqual(c.databases);
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
