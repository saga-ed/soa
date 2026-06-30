/**
 * Per-snapshot manifest schema unit tests (plan §4.3, §7.2 "M3", saga-ed/soa#214).
 *
 * The snapshot `manifest.json` is one of only two places the CLI uses zod+JSON
 * (the other is `flows.json`): an on-disk artifact written by one run and read by
 * a later, possibly newer, CLI — so it is validated at the boundary. These tests
 * pin the round-trip (serialize → JSON.parse → parse is identity) and the
 * boundary rejections (bad db id, bad engine, missing/invalid fields), so a
 * stale or corrupt manifest is caught rather than silently mis-restored.
 *
 * PURE: pure parse/serialize helpers only — no fs.
 */

import { describe, expect, it } from 'vitest';
import {
  CURRENT_SNAPSHOT_SCHEMA_VERSION,
  parseSnapshotManifest,
  safeParseSnapshotManifest,
  serializeSnapshotManifest,
} from '../index.js';
import type { SnapshotManifest } from '../index.js';

const VALID: SnapshotManifest = {
  schemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
  fixtureId: 'demo-small',
  profile: 'roster',
  createdAt: '2026-06-29T00:00:00.000Z',
  databases: [
    {
      db: 'iam_local',
      engine: 'postgres',
      ownerRole: 'iam',
      schemaRev: 'iam_local_mig_001',
      sizeBytes: 4096,
      file: 'iam_local.dump',
    },
    {
      db: 'iam_pii_local',
      engine: 'postgres',
      ownerRole: 'iam_pii',
      schemaRev: null, // db push — no migration history
      sizeBytes: 2048,
      file: 'iam_pii_local.dump',
    },
    {
      db: 'connectv3',
      engine: 'mongo',
      ownerRole: '',
      schemaRev: null, // mongo — schemaless
      sizeBytes: 8192,
      file: 'connectv3.archive',
    },
  ],
  systems: ['iam-api', 'connect-api'],
  flowId: 'flow-x',
};

describe('snapshot manifest — round-trip', () => {
  it('serialize → JSON.parse → parse is the identity', () => {
    const text = serializeSnapshotManifest(VALID);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseSnapshotManifest(JSON.parse(text))).toEqual(VALID);
  });

  it('parse accepts a minimal manifest (optional fields omitted)', () => {
    const minimal = {
      schemaVersion: 1,
      fixtureId: 'x',
      profile: 'roster',
      databases: [{ db: 'sis_db', engine: 'postgres', ownerRole: 'sis', schemaRev: null, file: 'sis_db.dump' }],
    };
    const parsed = parseSnapshotManifest(minimal);
    expect(parsed.fixtureId).toBe('x');
    expect(parsed.databases[0].sizeBytes).toBeUndefined();
    expect(parsed.systems).toBeUndefined();
  });
});

describe('snapshot manifest — boundary rejections', () => {
  it('rejects an unknown db id', () => {
    const bad = {
      ...VALID,
      databases: [{ ...VALID.databases[0], db: 'not_a_real_db' }],
    };
    expect(() => parseSnapshotManifest(bad)).toThrow();
    expect(safeParseSnapshotManifest(bad).success).toBe(false);
  });

  it('rejects an unknown engine', () => {
    const bad = { ...VALID, databases: [{ ...VALID.databases[0], engine: 'mysql' }] };
    expect(safeParseSnapshotManifest(bad).success).toBe(false);
  });

  it('rejects an unknown service id in `systems`', () => {
    const bad = { ...VALID, systems: ['ghost-api'] };
    expect(safeParseSnapshotManifest(bad).success).toBe(false);
  });

  it('rejects a missing required field (databases)', () => {
    const bad = { schemaVersion: 1, fixtureId: 'x', profile: 'roster' };
    expect(() => parseSnapshotManifest(bad)).toThrow();
  });

  it('rejects an empty dump filename', () => {
    const bad = { ...VALID, databases: [{ ...VALID.databases[0], file: '' }] };
    expect(safeParseSnapshotManifest(bad).success).toBe(false);
  });

  it('rejects a non-positive schemaVersion', () => {
    expect(safeParseSnapshotManifest({ ...VALID, schemaVersion: 0 }).success).toBe(false);
  });

  it('rejects a negative dump size', () => {
    const bad = { ...VALID, databases: [{ ...VALID.databases[0], sizeBytes: -1 }] };
    expect(safeParseSnapshotManifest(bad).success).toBe(false);
  });

  it('safeParse returns success:true for a valid manifest', () => {
    const parsed = safeParseSnapshotManifest(JSON.parse(serializeSnapshotManifest(VALID)));
    expect(parsed.success).toBe(true);
  });
});
