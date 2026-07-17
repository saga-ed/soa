/**
 * Pure snapshot-planner unit tests (plan §4.3, §7.2 "M3", saga-ed/soa#214).
 *
 * Drive `storePlan` / `restorePlan` / `validatePlan` / `evaluateValidation`
 * against the REAL frozen service manifest (the data under test). These are the
 * brains of the native fast-path — they decide WHICH DBs to dump/restore and
 * WHICH structural checks to run, all as plain data. The whole point of M3 is
 * the 6→10-pg + mongo extension over mesh-fixture-cli, so the load-bearing
 * assertion is the DEFAULT db set: all 10 pg app DBs (critically incl. `content`
 * AND `ledger_local` — the DBs mesh-fixture-cli's stale `SAGA_MESH_DATABASES`
 * missed) + the `connectv3` mongo DB.
 *
 * PURE: no fs / child_process / docker / network — `localMigrations` and the
 * observed file stats are constructed inline as inputs.
 */

import { describe, expect, it } from 'vitest';
import { computeClosure } from '../../closure.js';
import { manifest } from '../../manifest/index.js';
import type { DbId } from '../../manifest/index.js';
import {
  evaluateValidation,
  restorePlan,
  storePlan,
  validatePlan,
} from '../plan.js';
import type { ObservedFile } from '../plan.js';
import type { LocalMigrations, SnapshotDbEntry, SnapshotManifest } from '../manifest.js';

/** The 10 postgres app DBs (9 profile-empty.sql + coach_api created in prep). */
const PG_APP_DBS: DbId[] = [
  'iam_local',
  'iam_pii_local',
  'programs',
  'scheduling',
  'sessions',
  'content',
  'coach_api',
  'sis_db',
  'ads_adm_local',
  'ledger_local',
];
const PLAYBACK_DBS: DbId[] = ['transcripts_local', 'insights_local', 'chat_local'];

/**
 * Build a `SnapshotManifest` over `dbs`, mirroring `storePlan`'s capture rule:
 * a pg DB with prisma MIGRATION HISTORY (not `db push`) carries a synthetic
 * `schemaRev`; db-push (`iam_pii_local`) and mongo (`connectv3`) carry `null`.
 */
function buildSnapshot(
  dbs: DbId[],
  opts: { profile?: string; revFor?: (db: DbId) => string | null } = {},
): SnapshotManifest {
  const databases: SnapshotDbEntry[] = dbs.map((db) => {
    const def = manifest.databases[db];
    const hasHistory = def.engine === 'postgres' && def.migrate?.cmd !== 'prisma db push';
    const schemaRev = opts.revFor ? opts.revFor(db) : hasHistory ? `${db}_mig_001` : null;
    return {
      db,
      engine: def.engine,
      ownerRole: def.ownerRole,
      schemaRev,
      sizeBytes: 128,
      file: def.engine === 'mongo' ? `${db}.archive` : `${db}.dump`,
    };
  });
  return {
    schemaVersion: 1,
    fixtureId: 'fx',
    profile: opts.profile ?? 'roster',
    createdAt: '2026-06-29T00:00:00.000Z',
    databases,
  };
}

/** LocalMigrations that KNOW every captured rev (snapshot-ahead guard passes). */
function knownMigrations(snap: SnapshotManifest): LocalMigrations {
  const out: Record<string, readonly string[]> = {};
  for (const e of snap.databases) if (e.schemaRev) out[e.db] = [e.schemaRev];
  return out as LocalMigrations;
}

describe('storePlan — manifest-driven db set (the 6→10-pg + mongo extension)', () => {
  it('defaults to all 10 pg app DBs + connectv3 mongo, excluding playback', () => {
    const plan = storePlan(manifest, { fixtureId: 'x', profile: 'roster' });
    const pg = plan.databases.filter((d) => d.engine === 'postgres').map((d) => d.db);
    const mongo = plan.databases.filter((d) => d.engine === 'mongo').map((d) => d.db);

    expect(pg).toHaveLength(10);
    expect(new Set(pg)).toEqual(new Set(PG_APP_DBS));
    expect(mongo).toEqual(['connectv3']);
    // The DBs mesh-fixture-cli's stale 6-DB list missed:
    expect(pg).toContain('content');
    expect(pg).toContain('ledger_local');
    // Playback is opt-in only.
    for (const pb of PLAYBACK_DBS) expect(pg).not.toContain(pb);
  });

  it('--only scopes to the resolved closure db set', () => {
    const only = computeClosure(manifest, ['iam-api']).databases;
    const plan = storePlan(manifest, { fixtureId: 'x', profile: 'roster', only });
    expect(new Set(plan.databases.map((d) => d.db))).toEqual(
      new Set<DbId>(['iam_local', 'iam_pii_local']),
    );
  });

  it('--only overrides --with-playback (only fully determines the set)', () => {
    const only = computeClosure(manifest, ['iam-api']).databases;
    const plan = storePlan(manifest, {
      fixtureId: 'x',
      profile: 'roster',
      only,
      withPlayback: true,
    });
    expect(new Set(plan.databases.map((d) => d.db))).toEqual(
      new Set<DbId>(['iam_local', 'iam_pii_local']),
    );
  });

  it('--with-playback adds the transcripts/insights/chat trio', () => {
    const plan = storePlan(manifest, { fixtureId: 'x', profile: 'roster', withPlayback: true });
    const dbs = plan.databases.map((d) => d.db);
    expect(plan.databases.filter((d) => d.engine === 'postgres')).toHaveLength(13);
    for (const pb of PLAYBACK_DBS) expect(dbs).toContain(pb);
  });

  it('requests schemaRev capture for migrate-deploy DBs, SKIPS db-push + mongo', () => {
    const plan = storePlan(manifest, { fixtureId: 'x', profile: 'roster' });
    const by = new Map(plan.databases.map((d) => [d.db, d]));
    expect(by.get('iam_local')!.captureSchemaRev).toBe(true);
    expect(by.get('ads_adm_local')!.captureSchemaRev).toBe(true);
    expect(by.get('ledger_local')!.captureSchemaRev).toBe(true);
    // iam_pii_local = `prisma db push` (no _prisma_migrations head) → skipped.
    expect(by.get('iam_pii_local')!.captureSchemaRev).toBe(false);
    // connectv3 = mongo (schemaless) → skipped.
    expect(by.get('connectv3')!.captureSchemaRev).toBe(false);
  });

  it('preserves the restore-as-owner identity per DB (ledger_local → ledger)', () => {
    const plan = storePlan(manifest, { fixtureId: 'x', profile: 'roster' });
    const by = new Map(plan.databases.map((d) => [d.db, d]));
    expect(by.get('ledger_local')!.ownerRole).toBe('ledger');
    expect(by.get('iam_local')!.ownerRole).toBe('iam');
  });

  it('reports fully-captured services as `systems` for the default scope', () => {
    const plan = storePlan(manifest, { fixtureId: 'x', profile: 'roster' });
    // ads-adm-api owns BOTH ads_adm_local + ledger_local — fully covered.
    expect(plan.systems).toContain('ads-adm-api');
    expect(plan.systems).toContain('iam-api');
    expect(plan.systems).toContain('connect-api');
    // Playback services are not in the default scope.
    expect(plan.systems).not.toContain('transcripts-api');
  });
});

describe('restorePlan — PROFILE guard (bypassable by --force)', () => {
  const snap = buildSnapshot(['iam_local', 'iam_pii_local'], { profile: 'roster' });
  const known = knownMigrations(snap);

  it('refuses a cross-profile restore without --force', () => {
    const plan = restorePlan(snap, manifest, known, { currentProfile: 'full' });
    expect(plan.ok).toBe(false);
    const g = plan.guardFailures.find((f) => f.kind === 'profile-mismatch');
    expect(g?.bypassableByForce).toBe(true);
    expect(g?.message).toMatch(/profile/i);
    expect(plan.restoredServices).toEqual([]); // nothing restored ⇒ nothing reported
  });

  it('allows a cross-profile restore WITH --force', () => {
    const plan = restorePlan(snap, manifest, known, { currentProfile: 'full', force: true });
    expect(plan.ok).toBe(true);
    expect(plan.guardFailures).toHaveLength(0);
  });

  it('allows a same-profile restore, and skips the guard when profile is unknown', () => {
    expect(restorePlan(snap, manifest, known, { currentProfile: 'roster' }).ok).toBe(true);
    expect(restorePlan(snap, manifest, known, {}).ok).toBe(true);
  });
});

describe('restorePlan — SNAPSHOT-AHEAD guard (HARD, not bypassable)', () => {
  it('refuses a pg DB whose snapshot rev is absent locally, with the up --pull hint', () => {
    const snap = buildSnapshot(['iam_local']);
    const plan = restorePlan(snap, manifest, {}); // local checkout knows no migrations
    expect(plan.ok).toBe(false);
    const g = plan.guardFailures.find((f) => f.kind === 'snapshot-ahead');
    expect(g?.db).toBe('iam_local');
    expect(g?.bypassableByForce).toBe(false);
    expect(g?.message).toMatch(/up --pull/);
  });

  it('is HARD: --force does NOT bypass an unknown migration', () => {
    const snap = buildSnapshot(['iam_local']);
    expect(restorePlan(snap, manifest, {}, { force: true }).ok).toBe(false);
  });

  it('allows the restore once the rev is present locally', () => {
    const snap = buildSnapshot(['iam_local']);
    expect(restorePlan(snap, manifest, knownMigrations(snap)).ok).toBe(true);
  });

  it('exempts iam_pii_local (db push, schemaRev null) even with no local migrations', () => {
    const snap = buildSnapshot(['iam_pii_local']);
    const plan = restorePlan(snap, manifest, {});
    expect(plan.ok).toBe(true);
    expect(plan.guardFailures).toHaveLength(0);
  });

  it('exempts connectv3 (mongo, schemaRev null) from the guard', () => {
    const snap = buildSnapshot(['connectv3']);
    expect(restorePlan(snap, manifest, {}).ok).toBe(true);
  });
});

describe('restorePlan — DB-AHEAD guard (HARD, not bypassable)', () => {
  // buildSnapshot captures `iam_local_mig_001`; the checkout knows one newer.
  const REV = 'iam_local_mig_001';
  const NEWER = 'iam_local_mig_002';
  const snap = buildSnapshot(['iam_local']);
  const ordered: LocalMigrations = { iam_local: [REV, NEWER] };

  it('refuses when the live head is AHEAD of the snapshot rev', () => {
    const plan = restorePlan(snap, manifest, ordered, {
      liveSchemaRevs: { iam_local: NEWER },
    });
    expect(plan.ok).toBe(false);
    const g = plan.guardFailures.find((f) => f.kind === 'db-ahead');
    expect(g?.db).toBe('iam_local');
    expect(g?.bypassableByForce).toBe(false);
    expect(g?.message).toMatch(/AHEAD/);
    expect(g?.message).toMatch(/rewind _prisma_migrations/);
  });

  it('is HARD: --force does NOT bypass a migrated-ahead DB', () => {
    const plan = restorePlan(snap, manifest, ordered, {
      liveSchemaRevs: { iam_local: NEWER },
      force: true,
    });
    expect(plan.ok).toBe(false);
  });

  it('refuses when the live head is unknown to the local checkout', () => {
    const plan = restorePlan(snap, manifest, ordered, {
      liveSchemaRevs: { iam_local: 'not_a_known_migration' },
    });
    expect(plan.ok).toBe(false);
    expect(plan.guardFailures.some((f) => f.kind === 'db-ahead')).toBe(true);
  });

  it('allows an in-sync DB (live head equals the snapshot rev)', () => {
    const plan = restorePlan(snap, manifest, ordered, {
      liveSchemaRevs: { iam_local: REV },
    });
    expect(plan.ok).toBe(true);
    expect(plan.guardFailures).toHaveLength(0);
  });

  it('allows a live head strictly BEHIND the snapshot rev (dump carries the newer schema)', () => {
    const newerSnap = buildSnapshot(['iam_local'], { revFor: () => NEWER });
    const plan = restorePlan(newerSnap, manifest, ordered, {
      liveSchemaRevs: { iam_local: REV },
    });
    expect(plan.ok).toBe(true);
  });

  it('skips the guard when no live head was observed (absent or null)', () => {
    expect(restorePlan(snap, manifest, ordered, {}).ok).toBe(true);
    expect(
      restorePlan(snap, manifest, ordered, { liveSchemaRevs: { iam_local: null } }).ok,
    ).toBe(true);
  });
});

describe('restorePlan — restore-as-owner + fully-restored services', () => {
  const full = buildSnapshot([...PG_APP_DBS, 'connectv3']);
  const known = knownMigrations(full);

  it('orders actions in manifest declaration order and restores AS each owner', () => {
    const plan = restorePlan(full, manifest, known);
    expect(plan.ok).toBe(true);
    const ledger = plan.actions.find((a) => a.db === 'ledger_local');
    expect(ledger?.ownerRole).toBe('ledger'); // NOT ads_adm
    const order = plan.actions.map((a) => a.db);
    expect(order.indexOf('iam_local')).toBeLessThan(order.indexOf('ledger_local'));
    expect(plan.flushRedis).toBe(true);
  });

  it('includes a service whose ENTIRE db set is restored', () => {
    const plan = restorePlan(full, manifest, known);
    expect(plan.restoredServices).toContain('iam-api'); // iam_local + iam_pii_local
    expect(plan.restoredServices).toContain('ads-adm-api'); // ads_adm_local + ledger_local
    expect(plan.restoredServices).toContain('connect-api'); // connectv3
    // db-less services are never "restored".
    expect(plan.restoredServices).not.toContain('saga-dash');
  });

  it('EXCLUDES a service whose db set is only partially covered', () => {
    const partial = buildSnapshot(['iam_local']); // iam_pii_local missing
    const plan = restorePlan(partial, manifest, knownMigrations(partial));
    expect(plan.ok).toBe(true);
    expect(plan.restoredServices).not.toContain('iam-api');
  });
});

describe('validatePlan / evaluateValidation — offline structural gate', () => {
  it('builds one check per snapshot DB, with the dump path under the snapshot dir', () => {
    const snap = buildSnapshot(['iam_local', 'connectv3']);
    const plan = validatePlan('/snaps/fx', snap);
    expect(plan.checks).toHaveLength(2);
    expect(plan.checks.find((c) => c.db === 'iam_local')!.path).toBe('/snaps/fx/iam_local.dump');
    expect(plan.checks.find((c) => c.db === 'connectv3')!.path).toBe('/snaps/fx/connectv3.archive');
  });

  it('passes when every dump exists and is non-empty', () => {
    const plan = validatePlan('/snaps/fx', buildSnapshot(['iam_local', 'connectv3']));
    const observed = new Map<string, ObservedFile>(
      plan.checks.map((c) => [c.path, { path: c.path, exists: true, sizeBytes: 10 }]),
    );
    const result = evaluateValidation(plan, observed);
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails (missing) when a dump file is absent', () => {
    const plan = validatePlan('/snaps/fx', buildSnapshot(['iam_local', 'connectv3']));
    const observed = new Map<string, ObservedFile>(
      plan.checks.map((c, i) => [c.path, { path: c.path, exists: i !== 0, sizeBytes: 10 }]),
    );
    const result = evaluateValidation(plan, observed);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatchObject({ db: 'iam_local', reason: 'missing' });
  });

  it('fails (empty) when a dump file is zero bytes', () => {
    const plan = validatePlan('/snaps/fx', buildSnapshot(['iam_local']));
    const observed = new Map<string, ObservedFile>(
      plan.checks.map((c) => [c.path, { path: c.path, exists: true, sizeBytes: 0 }]),
    );
    const result = evaluateValidation(plan, observed);
    expect(result.ok).toBe(false);
    expect(result.failures.every((f) => f.reason === 'empty')).toBe(true);
  });

  it('--deep requests pg_restore --list for pg dumps only (not mongo)', () => {
    const plan = validatePlan('/snaps/fx', buildSnapshot(['iam_local', 'connectv3']), { deep: true });
    expect(plan.deep).toBe(true);
    expect(plan.checks.find((c) => c.db === 'iam_local')!.pgRestoreList).toBe(true);
    expect(plan.checks.find((c) => c.db === 'connectv3')!.pgRestoreList).toBe(false);
  });

  it('--deep fails when pg_restore --list could not read an archive', () => {
    const plan = validatePlan('/snaps/fx', buildSnapshot(['iam_local']), { deep: true });
    const observed = new Map<string, ObservedFile>(
      plan.checks.map((c) => [
        c.path,
        { path: c.path, exists: true, sizeBytes: 10, pgRestoreOk: c.pgRestoreList ? false : undefined },
      ]),
    );
    const result = evaluateValidation(plan, observed);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.reason === 'pg-restore-list-failed')).toBe(true);
  });
});
