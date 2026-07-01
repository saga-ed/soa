/**
 * Central slot guard (M7 Phase 1, plan §4/§6).
 *
 * `--slot` lives on `baseFlags`, so every command accepts it — but Phase 1 only
 * wires slot 0. `BaseCommand.parse` must reject `--slot > 0` on ANY command
 * (fail fast, not half-run at the base ports); slot 0 (default) must be
 * unaffected. Driven through the real `StackUp` command with `--dry-run` so no
 * IO seams are needed — the guard fires in `parse`, before any path branches.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { SLOT_PHASE2_MESSAGE } from '../../../shared-flags.js';
import StackUp from '../up.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

let config: Config;

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BaseCommand slot guard', () => {
  it('rejects --slot 1 with the Phase-2 error', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '1', ...WS], config),
    ).rejects.toThrow(SLOT_PHASE2_MESSAGE);
  });

  it('rejects a large slot too', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '7', ...WS], config),
    ).rejects.toThrow(/Phase 2/);
  });

  it('rejects a negative slot at the flag layer (min: 0)', async () => {
    // Flags.integer({ min: 0 }) rejects before the guard — still a hard error.
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '-1', ...WS], config),
    ).rejects.toBeInstanceOf(Error);
  });

  it('slot 0 (default, implicit) is accepted — no guard error', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('explicit --slot 0 is accepted', async () => {
    await expect(
      StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '0', ...WS], config),
    ).resolves.toBeUndefined();
  });
});
