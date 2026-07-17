/**
 * Advisory slot-claim hook (slot claims — "who last drove this slot").
 *
 * `BaseCommand.parse` writes `<stateDir>/claim.json` for every command that
 * opts in via `claimsSlot()` — AFTER the set-injection and the central slot
 * guard, so the claim records the slot the run actually targets. claim.json is
 * ADVISORY state (the deliberate counterpart to slot-active.ts's "no recorded
 * active state" stance), so the hook must be invisible on every other axis:
 * read-only commands never claim, `--dry-run` (mutates nothing) never claims,
 * and a claim-write failure never breaks the command.
 *
 * Like slot-guard.unit.test.ts, the command classes run in-process; the ONE
 * seam the hook uses (`getClaimWriter`) is spied on the prototype with a
 * recording fake, so we assert the WRITE PLAN (slot / stateDir / command line /
 * repo roots) without touching the filesystem.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { restoreEnv, saveEnv } from '../../../__tests__/helpers/env.js';
import { makeClaimWriter } from '../../../runtime/index.js';
import type { ClaimWriteInput } from '../../../runtime/index.js';
import StackSeed from '../seed.js';
import StackStatus from '../status.js';
import StackUp from '../up.js';

// Direct in-process runs bypass oclif's plugin loader, which is what normally
// stamps `static id` onto each command class — without it, `Command.run` falls
// back to the lowercased class name ('stackseed'). Pin the real ids so the
// claim's recorded command line matches production ('saga-stack stack:seed …').
StackSeed.id = 'stack:seed';
StackStatus.id = 'stack:status';
StackUp.id = 'stack:up';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const WS = ['--soa', SOA_ROOT, '--dev', '/fixed/dev'];

// Slot-parameterized commands (seed --slot 2 below) apply the slot env seam to
// process.env — save/restore so no test leaks it (the slot-guard/up-native recipe).
const SLOT_ENV_KEYS = [
  'SAGA_MESH_POSTGRES_CONTAINER',
  'SAGA_MESH_REDIS_CONTAINER',
  'SAGA_MESH_RABBITMQ_CONTAINER',
  'SAGA_MESH_MONGO_CONTAINER',
  'SAGA_MESH_CONNECT_MONGO_CONTAINER',
  'SAGA_MESH_SNAPSHOTS_DIR',
];

let config: Config;
let writes: ClaimWriteInput[];
let savedEnv: ReturnType<typeof saveEnv>;

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  writes = [];
  savedEnv = saveEnv(SLOT_ENV_KEYS);
  // In-process command runs share one process — and therefore the per-process
  // nested-claim latch (first claim wins). Each test is its own "process".
  BaseCommand.resetSlotClaimLatchForTests();
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  // The recording claim-writer fake on the ONE seam the hook uses.
  vi.spyOn(
    BaseCommand.prototype as unknown as { getClaimWriter: () => unknown },
    'getClaimWriter',
  ).mockReturnValue({
    async write(input: ClaimWriteInput) {
      writes.push(input);
    },
  });
  // Neutralize the delegated child processes so an accepted run never spawns.
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => unknown },
    'getRunner',
  ).mockReturnValue({ async run() { return { code: 0 }; } });
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(savedEnv);
});

describe('a claiming command writes ONE claim on entry', () => {
  it('stack seed --slot 2 claims slot 2 with the derived state dir + command line', async () => {
    await StackSeed.run(['--slot', '2', ...WS], config);

    expect(writes).toHaveLength(1);
    const claim = writes[0]!;
    expect(claim.slot).toBe(2);
    expect(claim.stateDir).toBe('/tmp/sds-synthetic-s2');
    expect(claim.command).toContain('stack:seed');
    expect(claim.command).toContain('--slot 2');
    expect(claim.set).toBeUndefined(); // no --set injected this parse
    // Repo roots resolve exactly like every command's own resolution: the
    // typed `--soa` pin wins; every SET_REPO_KEYS key is present (the writer
    // skips the ones that don't exist on disk).
    expect(claim.repoRoots.soa).toBe(SOA_ROOT);
    expect(Object.keys(claim.repoRoots)).toHaveLength(9);
    expect(claim.repoRoots).toHaveProperty('sds');
  });

  it('an explicit --state-dir beats the derived slot state dir', async () => {
    await StackSeed.run(['--state-dir', '/tmp/claim-hook-test-sd', ...WS], config);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.stateDir).toBe('/tmp/claim-hook-test-sd');
    expect(writes[0]!.slot).toBe(0);
  });

  it('the per-process latch: a nested in-process re-invocation never overwrites the first claim', async () => {
    // cold-start/bootstrap chain StackUp.run() IN-PROCESS — the inner parse
    // must not clobber the user's real command line with a synthetic argv.
    await StackSeed.run(['--slot', '2', ...WS], config);
    await StackUp.run(['--slot', '2', ...WS, '--dry-run'], config);
    await StackSeed.run(['--slot', '3', ...WS], config);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.slot).toBe(2);
    expect(writes[0]!.command).toContain('stack:seed');
  });
});

describe('non-claiming paths write NOTHING', () => {
  it('a read-only command (stack status) never claims', async () => {
    vi.spyOn(
      BaseCommand.prototype as unknown as { getProber: () => unknown },
      'getProber',
    ).mockReturnValue({ async probe() { return { ok: true, status: 200 }; } });

    await StackStatus.run([...WS], config);
    expect(writes).toHaveLength(0);
  });

  it('--dry-run suppresses the claim (nothing mutated ⇒ nothing claimed)', async () => {
    await StackUp.run(['--only', 'iam-api', '--dry-run', '--slot', '1', ...WS], config);
    expect(writes).toHaveLength(0);
  });
});

describe('advisory means advisory: a claim-write failure never breaks the command', () => {
  it('the REAL writer folds a throwing writeFile to a no-op and seed still succeeds', async () => {
    // Real makeClaimWriter, fake deps: writeFile always throws (an unwritable
    // state dir), dirExists false (no git spawns for sourceAtLaunch), SS_ACTOR
    // pinned (no /proc ancestry walk).
    vi.spyOn(
      BaseCommand.prototype as unknown as { getClaimWriter: () => unknown },
      'getClaimWriter',
    ).mockReturnValue(
      makeClaimWriter({
        env: { SS_ACTOR: 'claim-hook-test' },
        dirExists: () => false,
        writeFile: () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    );

    await expect(StackSeed.run([...WS], config)).resolves.toBeUndefined();
  });
});
