/**
 * `stack wipe` integration tests (soa#340 — pristine-reset ONE slot) — in-process
 * (`Config.load(PKG_ROOT)` + `StackWipe.run(argv, config)`), every destructive
 * seam faked on `BaseCommand.prototype` so NO real process / docker / fs is ever
 * touched:
 *
 *   - `getServiceStopper` — down's kill-by-pidfile path (step a); records the
 *     state dir it was driven against.
 *   - `getDockerWipe`     — the project-scoped `compose -p soa-s<N> down -v`
 *     seam (step b); records the ComposeTarget. `systemPrune` recording proves
 *     wipe NEVER goes host-global.
 *   - `getSlotWipe`       — the state-dir / snapshots `rm -rf` seam (steps c+d);
 *     a recorder keyed by the path removed.
 *   - `getConfirm` / `getClaimReader` / `getClaimWriter` — the guard seams
 *     (destructive prompt, live-claim refusal, advisory claim hook).
 *
 * Every fake pushes into ONE ordered `events` list, so the spec's step order —
 * stop → volumes → state dir (→ snapshots only with `--snapshots`) — is asserted
 * as a single sequence. Covers: slot 0 + bare invocation refused (pointer to
 * cold-start, nothing executed); `--dry-run` enumerates with zero teardown calls
 * AND zero claim writes; the `--slot 3 --yes` happy path with soa-s3-scoped args
 * and snapshots KEPT by default; `--snapshots` adding the per-slot snapshot dir;
 * the live-claim guard (refuses without `--yes`, proceeds with it, stale claims
 * never block); the set-binding "worktrees are NOT touched" notice; a declined
 * prompt tearing down nothing; and the pinned `--output-json` shape.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreEnv, saveEnv } from '../../../__tests__/helpers/env.js';
import { spySetStore, spySlotActive } from '../../../__tests__/helpers/set-fakes.js';
import { BaseCommand } from '../../../base-command.js';
import type {
  ClaimReadResult,
  ClaimReader,
  ClaimWriteInput,
  ComposeTarget,
  ConfirmSeam,
  DockerWipe,
  DockerWipeResult,
  SlotClaim,
  SlotWipe,
  StopServiceResult,
} from '../../../runtime/index.js';
import StackWipe from '../wipe.js';

// Direct in-process runs bypass oclif's plugin loader (which stamps `static id`);
// pin the real id so refusal text / the claim's command line match production.
StackWipe.id = 'stack:wipe';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

/** deriveInstance({slot: 3})'s targets — the paths/project every step is scoped by. */
const STATE_S3 = '/tmp/sds-synthetic-s3';
const PROJECT_S3 = 'soa-s3';
const SNAP_S3 = join(homedir(), '.saga-mesh', 'snapshots-s3');

// Slot-parameterized commands may apply the slot env seam to process.env —
// save/restore so no test leaks it (the claim-hook/up-native recipe).
const SLOT_ENV_KEYS = [
  'SAGA_MESH_POSTGRES_CONTAINER',
  'SAGA_MESH_REDIS_CONTAINER',
  'SAGA_MESH_RABBITMQ_CONTAINER',
  'SAGA_MESH_MONGO_CONTAINER',
  'SAGA_MESH_CONNECT_MONGO_CONTAINER',
  'SAGA_MESH_SNAPSHOTS_DIR',
];

let config: Config;
let savedEnv: ReturnType<typeof saveEnv>;
/** ONE ordered log across all destructive fakes — the step-order assertions read this. */
let events: string[];
let out: string[];
let prompts: string[];
let claimWrites: ClaimWriteInput[];
let composeTargets: ComposeTarget[];

/** Canned stop results for the default stopper fake (one term, one kill). */
const STOPPED: StopServiceResult[] = [
  { id: 'iam-api', pid: 200, outcome: 'term' },
  { id: 'rtsm-api', pid: 201, outcome: 'kill' },
];

/** Fake the native service-stopper (step a); records `stop:<stateDir>`. */
function installStopper(result: StopServiceResult[] = STOPPED): void {
  vi.spyOn(
    BaseCommand.prototype as unknown as { getServiceStopper: () => unknown },
    'getServiceStopper',
  ).mockReturnValue(async (stateDir: string) => {
    events.push(`stop:${stateDir}`);
    return result;
  });
}

/** Fake the project-scoped docker wipe (step b); records target + any prune. */
function installDockerWipe(ok = true): void {
  composeTargets = [];
  const fake: DockerWipe = {
    async composeDownVolumes(target: ComposeTarget): Promise<DockerWipeResult> {
      composeTargets.push(target);
      events.push(`docker-down-v:${target.project}`);
      return { ok, code: ok ? 0 : 1 };
    },
    async systemPrune(): Promise<DockerWipeResult> {
      events.push('system-prune'); // wipe must NEVER call this (host-global).
      return { ok: true, code: 0 };
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getDockerWipe: () => DockerWipe },
    'getDockerWipe',
  ).mockReturnValue(fake);
}

/**
 * Fake the state-dir/snapshots remover seam (steps c+d) — `getSlotWipe` on
 * BaseCommand.prototype (spec seam name; runtime `SlotWipe.remove(dir): boolean`).
 * Records every removal as `rm:<path>` and answers `true` ("existed and was
 * removed"), so the emitted JSON's `stateDirRemoved`/`snapshotsRemoved` are
 * booleans exactly as in a real successful wipe. If the seam is absent on the
 * prototype, `vi.spyOn` throws in beforeEach — failing FAST before any real
 * rm could run.
 */
function installSlotWipe(): void {
  const fake: SlotWipe = {
    remove(dir: string): boolean {
      events.push(`rm:${dir}`);
      return true;
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSlotWipe: () => SlotWipe },
    'getSlotWipe',
  ).mockReturnValue(fake);
}

/** Fake the confirm seam; records every prompt question. */
function installConfirm(answer: boolean): void {
  const confirm: ConfirmSeam = {
    isTTY: () => true,
    async prompt(question: string): Promise<boolean> {
      prompts.push(question);
      return answer;
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getConfirm: () => ConfirmSeam },
    'getConfirm',
  ).mockReturnValue(confirm);
}

/** A canned claim-read result; `over` patches the claim, `live` the pid verdict. */
function claimResult(over: Partial<SlotClaim> = {}, live = true): ClaimReadResult {
  return {
    live,
    claim: {
      version: 1,
      actor: 'coach-aug3-training',
      actorSource: 'env',
      pid: 41234, // NOT this test process — "another running driver" by definition.
      command: 'ss stack:up --slot 3',
      at: '2026-07-16T09:00:00.000Z',
      cwd: '/home/x',
      slot: 3,
      sourceAtLaunch: {},
      ...over,
    },
  };
}

/** Spy `getClaimReader` to a canned reader keyed by state dir (unknown dirs ⇒ null). */
function installClaimReader(byStateDir: Record<string, ClaimReadResult> = {}): void {
  const reader: ClaimReader = {
    read: (stateDir: string) => byStateDir[stateDir] ?? null,
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getClaimReader: () => ClaimReader },
    'getClaimReader',
  ).mockReturnValue(reader);
}

/** Extract the emitted JSON object from the captured log lines (tolerates step lines before it). */
function emittedJson(): Record<string, unknown> {
  const text = out.join('\n');
  const start = text.indexOf('{');
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  savedEnv = saveEnv(SLOT_ENV_KEYS);
  events = [];
  out = [];
  prompts = [];
  claimWrites = [];
  // In-process runs share one process — and the per-process claim latch.
  BaseCommand.resetSlotClaimLatchForTests();
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
  // Recording claim-writer fake — the advisory hook must never hit the real fs.
  vi.spyOn(
    BaseCommand.prototype as unknown as { getClaimWriter: () => unknown },
    'getClaimWriter',
  ).mockReturnValue({
    async write(input: ClaimWriteInput): Promise<void> {
      claimWrites.push(input);
    },
  });
  // Neutralize any delegated child process — nothing may ever spawn under test.
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => unknown },
    'getRunner',
  ).mockReturnValue({
    async run(): Promise<{ code: number }> {
      return { code: 0 };
    },
  });
  // Safe defaults: no sets, no live slots, no prior claims, all teardown seams faked.
  spySetStore({ version: 1, sets: {} });
  spySlotActive([]);
  installClaimReader();
  installStopper();
  installDockerWipe();
  installSlotWipe();
  installConfirm(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(savedEnv);
});

/** The full slot-3 teardown sequence (no `--snapshots`) every happy path must produce. */
const S3_TEARDOWN = [`stop:${STATE_S3}`, `docker-down-v:${PROJECT_S3}`, `rm:${STATE_S3}`];

describe('stack wipe — refusals exit non-zero and execute NOTHING', () => {
  it('bare invocation (slot 0 by default) is refused with a pointer to cold-start', async () => {
    await expect(StackWipe.run([...WS], config)).rejects.toThrow(/cold-start/);
    expect(events).toEqual([]);
  });

  it('an explicit --slot 0 is refused the same way', async () => {
    await expect(StackWipe.run(['--slot', '0', ...WS], config)).rejects.toThrow(/cold-start/);
    expect(events).toEqual([]);
  });
});

describe('stack wipe --dry-run — enumerates, changes nothing, claims nothing', () => {
  it('prints the slot-3 plan (project + state dir) with ZERO teardown calls, ZERO claim writes, ZERO prompts', async () => {
    await expect(StackWipe.run(['--slot', '3', '--dry-run', ...WS], config)).resolves.toBeUndefined();

    const text = out.join('\n');
    expect(text).toContain(PROJECT_S3);
    expect(text).toContain(STATE_S3);
    expect(events).toEqual([]); // no stop, no docker, no rm.
    expect(claimWrites).toHaveLength(0); // dry-run suppresses the advisory claim.
    expect(prompts).toHaveLength(0); // nothing to confirm — nothing will die.
  });
});

describe('stack wipe --slot 3 --yes — the happy path', () => {
  it('stops services, removes containers+volumes, removes the state dir — in ORDER, all soa-s3-scoped', async () => {
    await expect(StackWipe.run(['--slot', '3', '--yes', ...WS], config)).resolves.toBeUndefined();

    expect(events).toEqual(S3_TEARDOWN);
    // The compose target carries THIS slot's project and the resolved soa root.
    expect(composeTargets).toEqual([{ soaRoot: SOA_ROOT, project: PROJECT_S3 }]);
    // --yes skipped the prompt; the host-global prune was never touched.
    expect(prompts).toHaveLength(0);
    expect(events).not.toContain('system-prune');
    // Snapshots are KEPT by default.
    expect(events).not.toContain(`rm:${SNAP_S3}`);
    // The advisory claim was recorded on entry (claimsSlot — who attempted the wipe).
    expect(claimWrites).toHaveLength(1);
    expect(claimWrites[0]!.slot).toBe(3);
    expect(claimWrites[0]!.stateDir).toBe(STATE_S3);
  });

  it('--snapshots ALSO removes the per-slot snapshots dir (after the state dir)', async () => {
    await expect(
      StackWipe.run(['--slot', '3', '--yes', '--snapshots', ...WS], config),
    ).resolves.toBeUndefined();

    expect(events).toEqual([...S3_TEARDOWN, `rm:${SNAP_S3}`]);
  });

  it('a declined prompt tears down NOTHING', async () => {
    installConfirm(false);

    // Abort convention (return vs error) is the command's choice — either way,
    // no teardown step may have run.
    await StackWipe.run(['--slot', '3', ...WS], config).catch(() => undefined);

    expect(prompts).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('stack wipe — live-claim guard', () => {
  it("refuses when another driver's claim is LIVE (actor named, 'still running'); nothing executed", async () => {
    installClaimReader({ [STATE_S3]: claimResult({}, true) });

    await expect(StackWipe.run(['--slot', '3', ...WS], config)).rejects.toThrow(
      /coach-aug3-training[\s\S]*still running/,
    );
    expect(events).toEqual([]);
  });

  it('--yes overrides a live claim and proceeds with the full teardown', async () => {
    installClaimReader({ [STATE_S3]: claimResult({}, true) });

    await expect(StackWipe.run(['--slot', '3', '--yes', ...WS], config)).resolves.toBeUndefined();
    expect(events).toEqual(S3_TEARDOWN);
  });

  it('a STALE claim (dead pid) never blocks — confirmed run proceeds without --yes', async () => {
    installClaimReader({ [STATE_S3]: claimResult({ actor: 'claude:41234' }, false) });
    installConfirm(true);

    await expect(StackWipe.run(['--slot', '3', ...WS], config)).resolves.toBeUndefined();
    expect(events).toEqual(S3_TEARDOWN);
  });
});

describe('stack wipe — set-bound slot', () => {
  it("names the owning set and states its worktrees are NOT touched (checkouts survive a wipe)", async () => {
    spySetStore({
      version: 1,
      sets: { 'journey-fix': { slot: 3, repos: { 'saga-dash': '/wt/dash-j' } } },
    });
    installConfirm(true);

    await expect(StackWipe.run(['--slot', '3', ...WS], config)).resolves.toBeUndefined();

    // The notice may live in the enumeration (log) or the prompt itself.
    const text = [...out, ...prompts].join('\n');
    expect(text).toContain('journey-fix');
    expect(text).toMatch(/worktree/i);
    expect(text).toMatch(/not touched|never touched|untouched|not removed|left (as-is|in place|alone)/i);
    // The wipe itself still ran — only the slot's runtime residue dies, never source.
    expect(events).toEqual(S3_TEARDOWN);
  });
});

describe('stack wipe --output-json — pinned shape', () => {
  it('emits exactly {slot, project, stateDir, stopped, volumesRemoved, stateDirRemoved, snapshotsRemoved}', async () => {
    await expect(
      StackWipe.run(['--slot', '3', '--yes', '--output-json', ...WS], config),
    ).resolves.toBeUndefined();

    const json = emittedJson();
    expect(Object.keys(json).sort()).toEqual([
      'project',
      'slot',
      'snapshotsRemoved',
      'stateDir',
      'stateDirRemoved',
      'stopped',
      'volumesRemoved',
    ]);
    expect(json).toMatchObject({
      slot: 3,
      project: PROJECT_S3,
      stateDir: STATE_S3,
      volumesRemoved: true,
      stateDirRemoved: true,
      snapshotsRemoved: false, // no --snapshots ⇒ kept.
    });
    expect(json.stopped).toBeDefined(); // derived from the StopServiceResult[].
  });
});
