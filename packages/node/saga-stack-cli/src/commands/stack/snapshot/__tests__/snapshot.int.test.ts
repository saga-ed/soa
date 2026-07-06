/**
 * Native snapshot store|restore|list|validate|delete integration tests (plan
 * §4.3, §7.2 "M3").
 *
 * These exercise the FULL command path — pure planners (core/snapshot) + on-disk
 * store + the injectable container IO — WITHOUT a real container, DB, or
 * pg_dump/mongodump binary. The `SnapshotIO` seam is replaced (via
 * `BaseCommand.prototype.getSnapshotIO`) with a fake that records every call and
 * writes a few canned bytes for each "dump" so the manifest/sizes/validate gate
 * are all real fs operations against a temp snapshots root
 * ($SAGA_MESH_SNAPSHOTS_DIR). The restore snapshot-ahead guard's local-migration
 * input is injected through `SnapshotRestore.prototype.localMigrationsFor`.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../../base-command.js';
import type { LocalMigrations, SnapshotManifest } from '../../../../core/snapshot/index.js';
import type { SnapshotIO } from '../../../../runtime/index.js';
import { useTempSnapshotsDir } from '../../../../__tests__/helpers/env.js';
import { fakeSnapshotIO, type SnapshotIOCall } from '../../../../__tests__/helpers/snapshot-io.js';
import SnapshotStore from '../store.js';
import SnapshotRestore from '../restore.js';
import SnapshotList from '../list.js';
import SnapshotValidate from '../validate.js';
import SnapshotDelete from '../delete.js';

const PKG_ROOT = process.cwd();
const CANNED_REV = 'mig_001';

let config: Config;
let out: string[];
const ioCalls: SnapshotIOCall[] = [];
const snapDir = useTempSnapshotsDir('saga-snap-');

/** Fake SnapshotIO: records calls; "dumps" write canned bytes so files are real. */
function installSnapshotIO(opts: { pgRestoreOk?: boolean } = {}): void {
  ioCalls.length = 0;
  // schemaRev: CANNED_REV so the restore snapshot-ahead guard has a REAL rev to
  // check against (this suite owns the hard-guard coverage).
  const fake = fakeSnapshotIO({ ioCalls, schemaRev: CANNED_REV, pgRestoreOk: opts.pgRestoreOk });
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSnapshotIO: () => SnapshotIO },
    'getSnapshotIO',
  ).mockReturnValue(fake);
}

/** Make the snapshot-ahead guard PASS by returning the canned rev for every DB. */
function installPassingMigrations(): void {
  vi.spyOn(
    SnapshotRestore.prototype as unknown as {
      localMigrationsFor: (s: SnapshotManifest) => LocalMigrations;
    },
    'localMigrationsFor',
  ).mockImplementation((s: SnapshotManifest) => {
    const m: Record<string, readonly string[]> = {};
    for (const d of s.databases) m[d.db] = [CANNED_REV];
    return m as LocalMigrations;
  });
}

function dbsCalled(op: string): string[] {
  return ioCalls.filter((c) => c.op === op).map((c) => c.db!);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  delete process.env.SEED_PROFILE;
  installSnapshotIO();
  installPassingMigrations();
  out = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SEED_PROFILE;
});

describe('stack snapshot store — manifest-driven, all 10 pg + connectv3 mongo', () => {
  it('dumps every non-playback DB (10 pg + connectv3 mongo) by default', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    const pg = dbsCalled('pgDump');
    expect(pg).toHaveLength(10);
    expect(pg).toContain('coach_api'); // the coach progress store (mesh app DB #10)
    expect(pg).toContain('ledger_local'); // the 7th-9th DBs mesh-fixture missed
    expect(pg).toContain('content');
    expect(dbsCalled('mongoDump')).toEqual(['connectv3']);
  });

  it('restores-as-owner identity is preserved per DB (ledger_local → ledger)', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    const ledger = ioCalls.find((c) => c.op === 'pgDump' && c.db === 'ledger_local');
    expect(ledger?.ownerRole).toBe('ledger');
    const iam = ioCalls.find((c) => c.op === 'pgDump' && c.db === 'iam_local');
    expect(iam?.ownerRole).toBe('iam');
  });

  it('captures schemaRev for migration DBs, null for db-push (iam_pii_local) + mongo', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo', '--output-json'], config);
    expect(dbsCalled('readSchemaRev')).not.toContain('iam_pii_local');
    expect(dbsCalled('readSchemaRev')).not.toContain('connectv3');
    expect(dbsCalled('readSchemaRev')).toContain('iam_local');
  });

  it('--only scopes the dump to the service closure DB set', async () => {
    await SnapshotStore.run(['--fixture-id', 'iam', '--only', 'iam-api'], config);
    expect(new Set(dbsCalled('pgDump'))).toEqual(new Set(['iam_local', 'iam_pii_local']));
    expect(dbsCalled('mongoDump')).toEqual([]);
  });

  it('M13-A: --slot 1 scopes the DEFAULT dump to the slot-provisioned DBs (excluded services dropped)', async () => {
    // The real applyInstanceEnv would point $SAGA_MESH_SNAPSHOTS_DIR at
    // ~/.saga-mesh/snapshots-s1 (real home!) — redirect it into the temp
    // snapshots root while still recording the slot profile it was given.
    let appliedSlot: number | undefined;
    vi.spyOn(
      BaseCommand.prototype as unknown as {
        applyInstanceEnv: (p: { slot: number; containerEnv: Record<string, string> }) => void;
      },
      'applyInstanceEnv',
    ).mockImplementation((profile) => {
      appliedSlot = profile.slot;
      for (const [k, v] of Object.entries(profile.containerEnv)) process.env[k] = v;
      process.env.SAGA_MESH_SNAPSHOTS_DIR = join(snapDir(), `s${profile.slot}`);
    });

    await SnapshotStore.run(['--fixture-id', 'slotted', '--slot', '1'], config);
    expect(appliedSlot).toBe(1);
    const pg = dbsCalled('pgDump');
    // The slot-excluded literal-port services' DBs are never provisioned in
    // soa-s1 and must not be dumped (post-closure filtering — a closure edge
    // like connect-web's -> connect-api would defeat a requested-set pre-filter).
    expect(dbsCalled('mongoDump')).toEqual([]); // connect-api (connectv3) is excluded
    // …while the slottable backends' DBs still are — including ads-adm-api's
    // (slottable since the tokenized-env + EXPRESS_SERVER_PORT change):
    expect(pg).toContain('ads_adm_local');
    expect(pg).toContain('ledger_local');
    expect(pg).toContain('iam_local');
    expect(pg).toContain('coach_api');
    // And the dump landed in the slot's (redirected) snapshot root.
    expect(process.env.SAGA_MESH_SNAPSHOTS_DIR).toBe(join(snapDir(), 's1'));
  });

  it('--with playback adds transcripts/insights/chat', async () => {
    await SnapshotStore.run(['--fixture-id', 'pb', '--with', 'playback'], config);
    expect(dbsCalled('pgDump')).toContain('transcripts_local');
    expect(dbsCalled('pgDump')).toContain('chat_local');
  });

  it('--only iam-api --with coach unions coach_api into the scoped closure', async () => {
    await SnapshotStore.run(
      ['--fixture-id', 'ic', '--only', 'iam-api', '--with', 'coach'],
      config,
    );
    const pg = new Set(dbsCalled('pgDump'));
    // iam's own DBs + coach's coach_api, and nothing outside that scope.
    expect(pg).toContain('iam_local');
    expect(pg).toContain('coach_api');
    expect(pg).not.toContain('programs');
    expect(dbsCalled('mongoDump')).toEqual([]);
  });

  it('writes a zod-valid manifest with profile + per-DB sizes', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo', '--profile', 'full', '--output-json'], config);
    const json = JSON.parse(out.join(''));
    expect(json).toMatchObject({ fixtureId: 'demo', profile: 'full', databases: 11 });
    expect(json.totalBytes).toBeGreaterThan(0);
    // manifest.json exists and parses
    expect(statSync(join(snapDir(), 'demo', 'manifest.json')).size).toBeGreaterThan(0);
  });

  it('refuses to overwrite an existing snapshot without --force', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    await expect(SnapshotStore.run(['--fixture-id', 'demo'], config)).rejects.toThrow(/already exists/);
  });
});

describe('stack snapshot restore — restore-as-owner + guards', () => {
  async function store(extra: string[] = []): Promise<void> {
    await SnapshotStore.run(['--fixture-id', 'demo', ...extra], config);
    ioCalls.length = 0; // reset so restore assertions see only restore-phase calls
    out = []; // and so JSON assertions parse only the restore output
  }

  it('restores every DB AS its owner, mongo too, then flushes redis', async () => {
    await store();
    await SnapshotRestore.run(['demo'], config);
    expect(dbsCalled('pgRestore')).toHaveLength(10);
    const ledger = ioCalls.find((c) => c.op === 'pgRestore' && c.db === 'ledger_local');
    expect(ledger?.ownerRole).toBe('ledger');
    expect(dbsCalled('mongoRestore')).toEqual(['connectv3']);
    expect(ioCalls.some((c) => c.op === 'redisFlushdb')).toBe(true);
  });

  it('reports fully-restored services for a full snapshot', async () => {
    await store();
    await SnapshotRestore.run(['demo', '--output-json'], config);
    const json = JSON.parse(out.join(''));
    expect(json.restoredServices).toContain('iam-api');
    expect(json.flushedRedis).toBe(true);
  });

  it('--no-flush-redis skips the redis flush', async () => {
    await store();
    await SnapshotRestore.run(['demo', '--no-flush-redis'], config);
    expect(ioCalls.some((c) => c.op === 'redisFlushdb')).toBe(false);
  });

  it('--only restores a subset (iam) of the snapshot', async () => {
    await store();
    await SnapshotRestore.run(['demo', '--only', 'iam-api'], config);
    expect(new Set(dbsCalled('pgRestore'))).toEqual(new Set(['iam_local', 'iam_pii_local']));
  });

  it('PROFILE guard: cross-profile restore is refused, --force bypasses it', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo', '--profile', 'roster'], config);
    ioCalls.length = 0;
    process.env.SEED_PROFILE = 'full';
    await expect(SnapshotRestore.run(['demo'], config)).rejects.toThrow(/profile/i);
    ioCalls.length = 0;
    await expect(SnapshotRestore.run(['demo', '--force'], config)).resolves.toBeUndefined();
    expect(dbsCalled('pgRestore').length).toBeGreaterThan(0);
  });

  it('SNAPSHOT-AHEAD guard is HARD: --force does NOT bypass an unknown migration', async () => {
    await store();
    // Local checkout knows NO migrations → snapshot rev is "ahead".
    vi.spyOn(
      SnapshotRestore.prototype as unknown as {
        localMigrationsFor: () => LocalMigrations;
      },
      'localMigrationsFor',
    ).mockReturnValue({} as LocalMigrations);
    await expect(SnapshotRestore.run(['demo', '--force'], config)).rejects.toThrow(/ahead|stack up --pull/i);
  });

  it('errors clearly when the snapshot does not exist', async () => {
    await expect(SnapshotRestore.run(['nope'], config)).rejects.toThrow(/no valid snapshot manifest/);
  });
});

describe('stack snapshot list / validate / delete', () => {
  it('list surfaces the stored snapshot with its profile + DB count', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo', '--profile', 'full'], config);
    ioCalls.length = 0;
    out = [];
    await SnapshotList.run(['--output-json'], config);
    const json = JSON.parse(out.join(''));
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ fixtureId: 'demo' });
    expect(json[0].manifest.profile).toBe('full');
  });

  it('validate passes (offline) for a freshly stored snapshot', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    out = [];
    await SnapshotValidate.run(['demo', '--output-json'], config);
    const json = JSON.parse(out.join(''));
    expect(json.ok).toBe(true);
    expect(json.checks).toBe(11);
  });

  it('validate --deep runs pg_restore --list on each pg dump', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    ioCalls.length = 0;
    await SnapshotValidate.run(['demo', '--deep'], config);
    expect(ioCalls.filter((c) => c.op === 'pgRestoreList')).toHaveLength(10); // pg dumps only
  });

  it('validate FAILS (exit 1) when a dump file is corrupt under --deep', async () => {
    installSnapshotIO({ pgRestoreOk: false });
    installPassingMigrations();
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    await expect(SnapshotValidate.run(['demo', '--deep'], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
  });

  it('validate FAILS (exit 1) when the snapshot is missing', async () => {
    await expect(SnapshotValidate.run(['ghost'], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
  });

  it('delete removes the snapshot directory', async () => {
    await SnapshotStore.run(['--fixture-id', 'demo'], config);
    await SnapshotDelete.run(['demo'], config);
    out = [];
    await SnapshotList.run(['--output-json'], config);
    const json = JSON.parse(out.join(''));
    expect(json).toHaveLength(0);
  });
});
