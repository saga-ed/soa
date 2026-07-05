/**
 * Central slot guard (M7 Phase 2, plan §4/§6).
 *
 * `--slot` lives on `baseFlags`, so every command accepts it. Phase 2 makes the
 * SLOT-AWARE commands (`stack up`/`status`/`verify`/`down`/`reset`/`login`, and
 * since M13-A also `seed` + the `snapshot` family) act on an isolated `soa-s<N>`
 * stack, while every OTHER command (`restart`/`overlay`/`bootstrap`/`tunnel`,
 * which delegate to host-global lifecycle) must FAIL FAST at `--slot > 0`.
 * `BaseCommand.parse` enforces this via the per-command `slotAware()` opt-in.
 *
 * The slot-aware paths are exercised through `--dry-run` (up) / delegated seams
 * elsewhere; here we assert only the GUARD boundary: which commands accept a
 * `--slot > 0` and which reject it. Slot 0 (the default) must be accepted by all.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { restoreEnv, saveEnv } from '../../../__tests__/helpers/env.js';
import StackReset from '../reset.js';
import StackRestart from '../restart.js';
import StackSeed from '../seed.js';
import StackUp from '../up.js';
import SnapshotList from '../snapshot/list.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

let config: Config;
let logged: string[];

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
    logged.push(String(m ?? ''));
  });
  // Neutralize the wrappers' delegated up.sh call so a would-be accepted slot 0
  // run doesn't spawn a real process (the reject tests never reach it anyway).
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => unknown },
    'getRunner',
  ).mockReturnValue({ async run() { return { code: 0 }; } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('slot-aware commands ACCEPT --slot > 0 (Phase 2)', () => {
  it('stack up --slot 1 --dry-run is accepted (no guard error)', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '1', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('a large slot is accepted on stack up too', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '7', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('stack reset --slot 1 is accepted (M8 R4: native reset targets the slot containers)', async () => {
    await expect(StackReset.run(['--slot', '1', ...WS], config)).resolves.toBeUndefined();
  });
});

describe('wrapper-lifecycle commands HARD-ERROR at --slot > 0', () => {
  it('stack restart --slot 1 is rejected', async () => {
    await expect(StackRestart.run(['--slot', '1', ...WS], config)).rejects.toThrow(
      /not supported for this command/,
    );
  });
});

describe('M13-A: seed + snapshot are slot-aware now', () => {
  it('stack seed --slot 2 passes the guard (native seed runs against the slot containers)', async () => {
    await expect(StackSeed.run(['--slot', '2', ...WS], config)).resolves.toBeUndefined();
  });

  it('seed at slot > 0 SUBTRACTS the slot-excluded services (and says so)', async () => {
    await StackSeed.run(['--slot', '2', ...WS], config);
    const warn = logged.find((l) => l.includes('excluding literal-port'));
    expect(warn).toBeDefined();
    // The dropped set is exactly the excluded intersection — connect-api is
    // excluded at slot>0, iam-api never is (an inverted filter would flip this).
    expect(warn).toMatch(/connect-api/);
    expect(warn).not.toMatch(/iam-api/);
  });

  it('seed at slot 0 is byte-identical: no exclusion warning', async () => {
    await StackSeed.run([...WS], config);
    expect(logged.find((l) => l.includes('excluding literal-port'))).toBeUndefined();
  });

  it('stack snapshot list --slot 3 passes the guard and reads the slot snapshot root', async () => {
    const saved = saveEnv(['SAGA_MESH_SNAPSHOTS_DIR']);
    try {
      await expect(SnapshotList.run(['--slot', '3', ...WS], config)).resolves.toBeUndefined();
      // applyInstanceEnv pointed the resolver at the per-slot root.
      expect(process.env.SAGA_MESH_SNAPSHOTS_DIR).toMatch(/snapshots-s3$/);
    } finally {
      restoreEnv(saved);
    }
  });
});

describe('slot 0 is accepted everywhere', () => {
  it('explicit --slot 0 is accepted on a slot-aware command (up)', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '0', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('implicit slot 0 (no --slot) is accepted on a wrapper command (reset)', async () => {
    await expect(StackReset.run([...WS], config)).resolves.toBeUndefined();
  });

  it('the flag layer still rejects a negative slot (min: 0)', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '-1', ...WS], config),
    ).rejects.toBeInstanceOf(Error);
  });
});
