/**
 * composeSeedPlan unit tests (plan §4.1, §6.4).
 *
 * Exercises the three gates over the REAL seed registry derived from the frozen
 * manifest:
 *   1. partial-stack drop — a step whose service ∉ active is dropped.
 *   2. snapshot-skip — a step is dropped only when its service is in `restored`
 *      (the snapshot layer puts a service there only when ALL its DBs restored;
 *      a partial restore leaves it OUT ⇒ the step is KEPT).
 *   3. offline / online partition by requiresServiceUp.
 * Plus: a service that contributes no seed steps (sis-api) ⇒ empty plan.
 *
 * PURE: no docker/pnpm/network.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceId } from '../../manifest/index.js';
import { composeSeedPlan } from '../compose-seed-plan.js';
import { SEED_DATASET_VAR, SeedDatasetError } from '../datasets.js';
import type { SeedSelection, SeedStep } from '../types.js';

const set = (...ids: ServiceId[]): Set<ServiceId> => new Set(ids);
const ids = (steps: { id: string }[]): string[] => steps.map((s) => s.id);

describe('composeSeedPlan — gate 1: partial-stack drop', () => {
  it('drops steps whose owning service is not in the active closure', () => {
    const sel: SeedSelection = { profile: 'full' }; // iam-registry, iam-dev-user, iam, sessions, programs, scheduling, content, coach-pg
    const plan = composeSeedPlan(sel, set('iam-api'), set());

    // Only iam-api's steps survive (and they're offline — no requiresServiceUp).
    expect(ids(plan.offline)).toEqual(['iam-registry', 'iam-dev-user', 'iam']);
    expect(plan.online).toEqual([]);

    // sessions / programs / scheduling / content / coach-pg + coach-mongo dropped as
    // service-inactive (coach-api owns two full-profile steps now — dedupe the services).
    const dropped = plan.skipped.filter((s) => s.reason === 'service-inactive');
    expect([...new Set(dropped.map((s) => s.service))].sort()).toEqual(
      ['coach-api', 'content-api', 'programs-api', 'scheduling-api', 'sessions-api'].sort(),
    );
  });
});

describe('composeSeedPlan — gate 2: snapshot-skip (service granularity)', () => {
  const sel: SeedSelection = { profile: 'roster' }; // iam-registry, iam-dev-user, iam, sessions
  const active = set('iam-api', 'sessions-api');

  it('drops a fully-restored service\'s steps; keeps the rest', () => {
    const plan = composeSeedPlan(sel, active, set('iam-api'));
    expect(ids(plan.offline)).toEqual(['sessions']); // sessions-api not restored ⇒ kept
    expect(plan.skipped.filter((s) => s.reason === 'service-restored').map((s) => s.id)).toEqual([
      'iam-registry',
      'iam-dev-user',
      'iam',
    ]);
  });

  it('keeps all steps when nothing is restored', () => {
    const plan = composeSeedPlan(sel, active, set());
    expect(ids(plan.offline)).toEqual(['iam-registry', 'iam-dev-user', 'iam', 'sessions']);
    expect(plan.skipped).toEqual([]);
  });

  // The DB-level "skip only when ALL of a service's DBs restored (iam owns two —
  // partial ⇒ still seed)" computation lives in the snapshot layer that decides
  // whether iam-api ∈ restored; it is not part of composeSeedPlan (M0).
  it.todo('snapshot layer: iam-api ∈ restored only when BOTH iam DBs restored (partial ⇒ kept)');

  it('EXEMPTS a `databases: []` static-fixture step (fga-bootstrap) even when its service is restored', () => {
    // A step that writes NO tracked DB is not represented in a PG snapshot, so a
    // service-restored skip must not swallow it. fga-bootstrap (service iam-api,
    // `databases: []`) writes the OpenFGA store — restoring iam-api's PG snapshot
    // says nothing about it, so it MUST still run.
    //
    // (This exemption used to be pinned by coach-mongo, the curriculum mongoimport.
    // Coach is single-store now — mongo is retired — so fga-bootstrap is the
    // remaining `databases: []` step and carries the case.)
    const sel: SeedSelection = { profile: 'full', addOns: ['authz'] };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'scheduling-api', 'content-api', 'coach-api');
    const plan = composeSeedPlan(sel, active, set('iam-api', 'coach-api'));

    // fga-bootstrap (databases: []) survives despite iam-api ∈ restored...
    expect(ids(plan.offline)).toContain('fga-bootstrap');
    // ...while the DB-writing steps of both restored services are skipped.
    expect(ids(plan.offline)).not.toContain('coach-pg');
    expect(ids(plan.offline)).not.toContain('iam');
    expect(plan.skipped.filter((s) => s.reason === 'service-restored').map((s) => s.id)).toEqual([
      'iam-registry',
      'iam-dev-user',
      'iam',
      'coach-pg',
    ]);
  });
});

describe('composeSeedPlan — gate 3: offline / online partition', () => {
  it('partitions survivors by requiresServiceUp, in canonical run order', () => {
    const sel: SeedSelection = { profile: 'full', addOns: ['qtf'] };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'scheduling-api', 'content-api', 'coach-api');
    const plan = composeSeedPlan(sel, active, set());

    // qtf-demo (requires sessions-api) + content (requires content-api) defer online;
    // scheduling + coach-pg (db:seed, no requiresServiceUp) stay offline. coach-pg
    // trails content in the canonical run order, and is now coach's ONLY seed step
    // (mongo is retired — the former coach-mongo mongoimport is gone).
    expect(ids(plan.offline)).toEqual([
      'iam-registry',
      'iam-dev-user',
      'iam',
      'sessions',
      'programs',
      'scheduling',
      'coach-pg',
    ]);
    expect(ids(plan.online)).toEqual(['qtf-demo', 'content']);
    expect(plan.skipped).toEqual([]);
  });
});

describe('composeSeedPlan — iam-registry precedes iam-dev-user (soa#253)', () => {
  // The registry (Permission/Policy catalog) is an OFFLINE step that iam-dev-user's
  // dev-admin grant depends on. composeSeedPlan appends offline steps in
  // SEED_RUN_ORDER position, so iam-registry must land in the OFFLINE batch strictly
  // before iam-dev-user — deterministically, for every iam-seeding profile.
  for (const profile of ['roster', 'full'] as const) {
    it(`${profile}: emits iam-registry before iam-dev-user in the offline batch`, () => {
      const active = set('iam-api', 'sessions-api', 'programs-api', 'scheduling-api', 'content-api', 'coach-api');
      const plan = composeSeedPlan({ profile }, active, set());
      const offlineIds = ids(plan.offline);
      const reg = offlineIds.indexOf('iam-registry');
      const dev = offlineIds.indexOf('iam-dev-user');
      expect(reg).toBeGreaterThanOrEqual(0);
      expect(dev).toBeGreaterThanOrEqual(0);
      expect(reg).toBeLessThan(dev);
      // and it is offline (never deferred online).
      expect(ids(plan.online)).not.toContain('iam-registry');
    });
  }
});

describe('composeSeedPlan — service with no seed steps', () => {
  it('sis-api alone ⇒ no seed steps (it contributes none)', () => {
    const sel: SeedSelection = { profile: 'full', only: ['sis-api'] };
    const plan = composeSeedPlan(sel, set('iam-api', 'sis-api'), set());
    expect(plan.offline).toEqual([]);
    expect(plan.online).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('composeSeedPlan — selection refinements', () => {
  it('addOns: playback adds the provision (bootstrap+migrate) + fixture offline steps', () => {
    const sel: SeedSelection = { profile: 'roster', addOns: ['playback'] };
    const active = set('iam-api', 'sessions-api', 'transcripts-api', 'insights-api', 'chat-api');
    const plan = composeSeedPlan(sel, active, set());
    // M8 R5: each playback DB is provisioned (bootstrap SQL + migrate) BEFORE its
    // fixture seed, so the provision steps precede transcripts/insights/chat.
    expect(ids(plan.offline)).toEqual([
      'iam-registry',
      'iam-dev-user',
      'iam',
      'sessions',
      'transcripts-provision',
      'insights-provision',
      'chat-provision',
      'transcripts',
      'insights',
      'chat',
    ]);
  });

  it('exclude drops a step by id without recording a skip note', () => {
    const sel: SeedSelection = { profile: 'roster', exclude: ['sessions'] };
    const plan = composeSeedPlan(sel, set('iam-api', 'sessions-api'), set());
    expect(ids(plan.offline)).toEqual(['iam-registry', 'iam-dev-user', 'iam']);
    expect(plan.skipped).toEqual([]); // excluded ≠ skipped (never requested)
  });
});

describe('composeSeedPlan — per-system profile overrides (M5)', () => {
  it('unions ONLY the named system’s steps at the heavier profile onto a roster base', () => {
    // base roster = {iam-registry, iam-dev-user, iam, sessions}; override seeds
    // programs-api at full (adds `programs`) WITHOUT pulling content-api in (rest stay roster).
    const sel: SeedSelection = { profile: 'roster', perSystem: [{ system: 'programs-api', profile: 'full' }] };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'content-api');
    const plan = composeSeedPlan(sel, active, set());
    expect(ids(plan.offline)).toEqual(['iam-registry', 'iam-dev-user', 'iam', 'sessions', 'programs']);
    // content (the other full-only step) is NOT seeded — heterogeneous profiles.
    expect(ids(plan.offline)).not.toContain('content');
  });

  it('is a no-op when the override profile adds nothing new for that system', () => {
    // iam-api already contributes iam-registry + iam-dev-user + iam at roster; overriding
    // it to full adds no iam-api steps (full’s extra steps belong to other services).
    const sel: SeedSelection = { profile: 'roster', perSystem: [{ system: 'iam-api', profile: 'full' }] };
    const plan = composeSeedPlan(sel, set('iam-api', 'sessions-api'), set());
    expect(ids(plan.offline)).toEqual(['iam-registry', 'iam-dev-user', 'iam', 'sessions']);
  });

  it('absent perSystem ⇒ identical to the M4 single-profile shape', () => {
    const base: SeedSelection = { profile: 'full' };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'content-api');
    const a = composeSeedPlan(base, active, set());
    const b = composeSeedPlan({ ...base, perSystem: [] }, active, set());
    expect(ids(a.offline)).toEqual(ids(b.offline));
    expect(ids(a.online)).toEqual(ids(b.online));
  });
});

describe('composeSeedPlan — multi-seed datasets (#221)', () => {
  const TRIAD_ACTIVE = set('iam-api', 'sessions-api', 'programs-api', 'scheduling-api');
  const fullSel: SeedSelection = { profile: 'full', scenario: 'ab-topology' };
  const varsOf = (s: SeedStep): Record<string, string> =>
    s.env.kind === 'dotenv' ? {} : s.env.vars;

  it("scenario stamps SEED_DATASET onto the triad's steps and ONLY those", () => {
    const plan = composeSeedPlan(fullSel, TRIAD_ACTIVE, set());
    const all = [...plan.offline, ...plan.online];

    const stamped = all.filter((s) => varsOf(s)[SEED_DATASET_VAR] === 'ab-topology');
    expect(stamped.map((s) => s.id).sort()).toEqual(['programs', 'scheduling', 'sessions']);

    // Non-triad steps (the iam trio: iam-registry/iam-dev-user/iam) carry NO dataset var.
    for (const s of all.filter((x) => !['programs', 'scheduling', 'sessions'].includes(x.id))) {
      expect(varsOf(s)[SEED_DATASET_VAR]).toBeUndefined();
    }
  });

  it('stamping CLONES — the frozen registry is untouched (a later plain compose is unstamped)', () => {
    composeSeedPlan(fullSel, TRIAD_ACTIVE, set());
    const plain = composeSeedPlan({ profile: 'full' }, TRIAD_ACTIVE, set());
    for (const s of [...plain.offline, ...plain.online]) {
      expect(varsOf(s)[SEED_DATASET_VAR]).toBeUndefined();
    }
  });

  it('a per-system dataset stamps just that system (identity axis; step selection unchanged)', () => {
    const sel: SeedSelection = {
      profile: 'roster',
      datasets: [{ system: 'sessions-api', dataset: 'alt' }],
    };
    const plan = composeSeedPlan(sel, set('iam-api', 'sessions-api'), set());
    expect(ids(plan.offline)).toEqual(['iam-registry', 'iam-dev-user', 'iam', 'sessions']); // same steps as plain roster
    const sessions = plan.offline.find((s) => s.id === 'sessions');
    expect(varsOf(sessions as SeedStep)[SEED_DATASET_VAR]).toBe('alt');
  });

  it('partition is unchanged by stamping (a stamped online step stays online)', () => {
    const sel: SeedSelection = {
      profile: 'full',
      datasets: [{ system: 'content-api', dataset: 'qtf-alt' }],
    };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'scheduling-api', 'content-api');
    const plan = composeSeedPlan(sel, active, set());
    const content = plan.online.find((s) => s.id === 'content');
    expect(varsOf(content as SeedStep)[SEED_DATASET_VAR]).toBe('qtf-alt');
  });

  it('COHERENCE: an inactive triad member fails the whole scenario (never a half-applied triad)', () => {
    // scheduling-api missing from the active set ⇒ its step drops as
    // service-inactive ⇒ the coupled ab-topology dataset CANNOT apply coherently.
    const active = set('iam-api', 'sessions-api', 'programs-api');
    expect(() => composeSeedPlan(fullSel, active, set())).toThrow(SeedDatasetError);
    expect(() => composeSeedPlan(fullSel, active, set())).toThrow(/scheduling-api \(service-inactive\)/);
  });

  it('COHERENCE: a snapshot-restored triad member fails the scenario too', () => {
    expect(() => composeSeedPlan(fullSel, TRIAD_ACTIVE, set('programs-api'))).toThrow(
      /programs-api \(service-restored\)/,
    );
  });

  it('COHERENCE: a profile that never selects a mapped system explains the miss', () => {
    // roster selects no programs/scheduling steps at all (they are full-only).
    const sel: SeedSelection = { profile: 'roster', scenario: 'ab-topology' };
    expect(() => composeSeedPlan(sel, TRIAD_ACTIVE, set())).toThrow(/no step selected/);
  });

  it('CONFLICT: --dataset naming a different dataset for a scenario system throws', () => {
    const sel: SeedSelection = {
      profile: 'full',
      scenario: 'ab-topology',
      datasets: [{ system: 'programs-api', dataset: 'other' }],
    };
    expect(() => composeSeedPlan(sel, TRIAD_ACTIVE, set())).toThrow(/conflicting datasets/);
  });
});
