/**
 * Central slot guard (M7 Phase 2, plan §4/§6).
 *
 * `--slot` lives on `baseFlags`, so every command accepts it. Phase 2 makes the
 * SLOT-AWARE commands (`stack up`/`status`/`verify`/`down`) act on an isolated
 * `soa-s<N>` stack, while every OTHER command (the wrapper-lifecycle set —
 * `reset`/`restart`/`overlay`/`bootstrap`/`seed` — plus login/tunnel/snapshot,
 * which delegate to up.sh's host-global lifecycle) must FAIL FAST at `--slot > 0`.
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
import StackReset from '../reset.js';
import StackRestart from '../restart.js';
import StackSeed from '../seed.js';
import StackUp from '../up.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

let config: Config;

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
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

  it('stack seed --slot 2 is rejected', async () => {
    await expect(StackSeed.run(['--slot', '2', ...WS], config)).rejects.toThrow(
      /slot 0 only/,
    );
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
