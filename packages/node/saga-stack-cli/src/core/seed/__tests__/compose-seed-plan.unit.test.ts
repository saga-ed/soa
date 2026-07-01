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
import type { SeedSelection } from '../types.js';

const set = (...ids: ServiceId[]): Set<ServiceId> => new Set(ids);
const ids = (steps: { id: string }[]): string[] => steps.map((s) => s.id);

describe('composeSeedPlan — gate 1: partial-stack drop', () => {
  it('drops steps whose owning service is not in the active closure', () => {
    const sel: SeedSelection = { profile: 'full' }; // iam-dev-user, iam, sessions, programs, scheduling, content, coach-pg
    const plan = composeSeedPlan(sel, set('iam-api'), set());

    // Only iam-api's steps survive (and they're offline — no requiresServiceUp).
    expect(ids(plan.offline)).toEqual(['iam-dev-user', 'iam']);
    expect(plan.online).toEqual([]);

    // sessions / programs / scheduling / content / coach-pg dropped as service-inactive.
    const dropped = plan.skipped.filter((s) => s.reason === 'service-inactive');
    expect(dropped.map((s) => s.service).sort()).toEqual(
      ['coach-api', 'content-api', 'programs-api', 'scheduling-api', 'sessions-api'].sort(),
    );
  });
});

describe('composeSeedPlan — gate 2: snapshot-skip (service granularity)', () => {
  const sel: SeedSelection = { profile: 'roster' }; // iam-dev-user, iam, sessions
  const active = set('iam-api', 'sessions-api');

  it('drops a fully-restored service\'s steps; keeps the rest', () => {
    const plan = composeSeedPlan(sel, active, set('iam-api'));
    expect(ids(plan.offline)).toEqual(['sessions']); // sessions-api not restored ⇒ kept
    expect(plan.skipped.filter((s) => s.reason === 'service-restored').map((s) => s.id)).toEqual([
      'iam-dev-user',
      'iam',
    ]);
  });

  it('keeps all steps when nothing is restored', () => {
    const plan = composeSeedPlan(sel, active, set());
    expect(ids(plan.offline)).toEqual(['iam-dev-user', 'iam', 'sessions']);
    expect(plan.skipped).toEqual([]);
  });

  // The DB-level "skip only when ALL of a service's DBs restored (iam owns two —
  // partial ⇒ still seed)" computation lives in the snapshot layer that decides
  // whether iam-api ∈ restored; it is not part of composeSeedPlan (M0).
  it.todo('snapshot layer: iam-api ∈ restored only when BOTH iam DBs restored (partial ⇒ kept)');
});

describe('composeSeedPlan — gate 3: offline / online partition', () => {
  it('partitions survivors by requiresServiceUp, in canonical run order', () => {
    const sel: SeedSelection = { profile: 'full', addOns: ['qtf'] };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'scheduling-api', 'content-api', 'coach-api');
    const plan = composeSeedPlan(sel, active, set());

    // qtf-demo (requires sessions-api) + content (requires content-api) defer online;
    // scheduling + coach-pg (db:seed, no requiresServiceUp) stay offline. coach-pg
    // trails content in the canonical run order.
    expect(ids(plan.offline)).toEqual(['iam-dev-user', 'iam', 'sessions', 'programs', 'scheduling', 'coach-pg']);
    expect(ids(plan.online)).toEqual(['qtf-demo', 'content']);
    expect(plan.skipped).toEqual([]);
  });
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
  it('addOns: playback adds transcripts/insights/chat offline steps', () => {
    const sel: SeedSelection = { profile: 'roster', addOns: ['playback'] };
    const active = set('iam-api', 'sessions-api', 'transcripts-api', 'insights-api', 'chat-api');
    const plan = composeSeedPlan(sel, active, set());
    expect(ids(plan.offline)).toEqual([
      'iam-dev-user',
      'iam',
      'sessions',
      'transcripts',
      'insights',
      'chat',
    ]);
  });

  it('exclude drops a step by id without recording a skip note', () => {
    const sel: SeedSelection = { profile: 'roster', exclude: ['sessions'] };
    const plan = composeSeedPlan(sel, set('iam-api', 'sessions-api'), set());
    expect(ids(plan.offline)).toEqual(['iam-dev-user', 'iam']);
    expect(plan.skipped).toEqual([]); // excluded ≠ skipped (never requested)
  });
});

describe('composeSeedPlan — per-system profile overrides (M5)', () => {
  it('unions ONLY the named system’s steps at the heavier profile onto a roster base', () => {
    // base roster = {iam-dev-user, iam, sessions}; override seeds programs-api at
    // full (adds `programs`) WITHOUT pulling content-api in (the rest stay roster).
    const sel: SeedSelection = { profile: 'roster', perSystem: [{ system: 'programs-api', profile: 'full' }] };
    const active = set('iam-api', 'sessions-api', 'programs-api', 'content-api');
    const plan = composeSeedPlan(sel, active, set());
    expect(ids(plan.offline)).toEqual(['iam-dev-user', 'iam', 'sessions', 'programs']);
    // content (the other full-only step) is NOT seeded — heterogeneous profiles.
    expect(ids(plan.offline)).not.toContain('content');
  });

  it('is a no-op when the override profile adds nothing new for that system', () => {
    // iam-api already contributes iam-dev-user + iam at roster; overriding it to
    // full adds no iam-api steps (full’s extra steps belong to other services).
    const sel: SeedSelection = { profile: 'roster', perSystem: [{ system: 'iam-api', profile: 'full' }] };
    const plan = composeSeedPlan(sel, set('iam-api', 'sessions-api'), set());
    expect(ids(plan.offline)).toEqual(['iam-dev-user', 'iam', 'sessions']);
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
