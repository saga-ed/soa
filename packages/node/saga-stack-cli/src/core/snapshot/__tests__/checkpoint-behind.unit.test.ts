/**
 * M14 checkpointBehindFailures: a checkpoint is a REPLAY substitute, so it
 * must sit AT the local migration head — the generic restore guard only
 * refuses AHEAD snapshots; this covers the BEHIND direction.
 */

import { describe, expect, it } from 'vitest';
import { checkpointBehindFailures } from '../plan.js';
import type { LocalMigrations, SnapshotManifest } from '../index.js';

const snap = (schemaRev: string | null): SnapshotManifest =>
  ({
    schemaVersion: 1,
    fixtureId: 'flow-x',
    profile: 'roster',
    databases: [{ db: 'programs', engine: 'pg', ownerRole: 'programs', schemaRev, file: 'programs.dump' }],
  }) as unknown as SnapshotManifest;

describe('checkpointBehindFailures', () => {
  it('at-head is clean', () => {
    const lm = { programs: ['m1', 'm2'] } as unknown as LocalMigrations;
    expect(checkpointBehindFailures(snap('m2'), lm)).toEqual([]);
  });

  it('BEHIND the head (baked before a migration landed) fails with a re-bake hint', () => {
    const lm = { programs: ['m1', 'm2'] } as unknown as LocalMigrations;
    const out = checkpointBehindFailures(snap('m1'), lm);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/programs: checkpoint schema is at m1.*head is m2.*re-bake/);
  });

  it('null rev (db-push / mongo) and unknown-local-migrations DBs are skipped', () => {
    expect(checkpointBehindFailures(snap(null), { programs: ['m1'] } as unknown as LocalMigrations)).toEqual([]);
    expect(checkpointBehindFailures(snap('m1'), {} as LocalMigrations)).toEqual([]);
  });
});
