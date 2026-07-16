/**
 * `stack slots` integration tests (slot claims) — in-process
 * (`Config.load(process.cwd())` + `StackSlots.run(argv, config)`), every seam
 * faked on `BaseCommand.prototype`: the slot-activity probe + set store via the
 * shared set-fakes helpers, the claim reader (canned per state dir — the
 * ADVISORY claim.json is never read off disk in a test), a local git runner
 * with `headSha` (the drift-since-launch column needs it; the shared
 * `spyGitRunner` fake doesn't carry it), and the repo-dir check (exact-path
 * allowlist so a developer's real checkouts / env pins never leak in).
 *
 * Covers: mixed active/claimed/set slots render rows while unused slots
 * collapse into one line; a dead-pid claim renders '(stale)'; the
 * `--output-json` shape (claim null when absent, posture rows, the
 * `postureSkipped` note for an active set-less slot > 0); porcelain TSV
 * stability (no color codes); and that a set-less active slot > 0 postures
 * nothing (zero git spawns).
 */

import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spySetStore, spySlotActive } from '../../../__tests__/helpers/set-fakes.js';
import { BaseCommand } from '../../../base-command.js';
import type { ClaimReadResult, ClaimReader, GitRunner, SlotClaim } from '../../../runtime/index.js';
import StackSlots from '../slots.js';

const PKG_ROOT = process.cwd();
const DEV_ROOT = '/fixed/dev';
// Pin the two repos the slot-0 posture assertions touch so a developer's
// $SOA/$SAGA_DASH env (baked into the flag defaults at import time) can't leak in.
const SOA_ROOT = `${DEV_ROOT}/soa`;
const DASH_ROOT = `${DEV_ROOT}/saga-dash`;
const WS = ['--dev', DEV_ROOT, '--soa', SOA_ROOT, '--saga-dash', DASH_ROOT];

/** deriveInstance's state dirs — the claim reader is keyed by them. */
const STATE_S2 = '/tmp/sds-synthetic-s2';
const STATE_S4 = '/tmp/sds-synthetic-s4';

/** The worktree path the `journey-fix` set (slot 2) pins saga-dash at. */
const WT_DASH = '/wt/dash-j';

let config: Config;
let out: string[];
let gitCalls: string[];

/** A canned claim-read result; `over` patches the claim fields, `live` the pid verdict. */
function claimResult(over: Partial<SlotClaim> = {}, live = true): ClaimReadResult {
  return {
    live,
    claim: {
      version: 1,
      actor: 'coach-aug3-training',
      actorSource: 'env',
      pid: 41234,
      command: 'ss stack:up --slot 2',
      at: '2026-07-16T12:00:00.000Z',
      cwd: '/home/x',
      slot: 2,
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

/**
 * Local git fake (the shared `spyGitRunner` lacks `headSha`, which the
 * drift-since-launch column reads): branches/dirtiness/behind-count/HEAD keyed
 * by repo path, every call recorded in `gitCalls` for the zero-spawn assertion.
 */
function installGit(
  opts: {
    branches?: Record<string, string>;
    dirty?: string[];
    behind?: Record<string, number>;
    heads?: Record<string, string>;
  } = {},
): void {
  gitCalls = [];
  const fake: Partial<GitRunner> = {
    branchShowCurrent: async (p: string) => {
      gitCalls.push(`branch:${p}`);
      return opts.branches?.[p] ?? 'main';
    },
    statusPorcelain: async (p: string) => {
      gitCalls.push(`status:${p}`);
      return (opts.dirty ?? []).includes(p) ? ' M src/x.ts\n' : '';
    },
    symbolicRefDefault: async (p: string) => {
      gitCalls.push(`default:${p}`);
      return 'main';
    },
    revParseVerify: async (p: string) => {
      gitCalls.push(`verify:${p}`);
      return true;
    },
    isAncestorOfHead: async (p: string) => {
      gitCalls.push(`ancestor:${p}`);
      return (opts.behind?.[p] ?? 0) === 0;
    },
    countBehindRef: async (p: string) => {
      gitCalls.push(`behind:${p}`);
      return opts.behind?.[p] ?? 0;
    },
    headSha: async (p: string) => {
      gitCalls.push(`head:${p}`);
      return opts.heads?.[p] ?? 'sha-current';
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getGitRunner: () => GitRunner },
    'getGitRunner',
  ).mockReturnValue(fake as GitRunner);
}

/** Only the listed EXACT paths exist — env-pinned real checkouts can never match. */
function installDirCheck(present: string[]): void {
  const set = new Set(present);
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
    'getRepoDirCheck',
  ).mockReturnValue((dir: string) => set.has(dir));
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  out = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
  // Safe defaults so NO test ever touches docker/state dirs/real git/claim files.
  spySlotActive([]);
  spySetStore({ version: 1, sets: {} });
  installClaimReader();
  installGit();
  installDirCheck([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack slots — who is on what slot (read-only)', () => {
  it('mixed active/claimed/set slots render rows; unused slots collapse into one line', async () => {
    spySlotActive(['soa', 'soa-s2']);
    spySetStore({
      version: 1,
      sets: { 'journey-fix': { slot: 2, repos: { 'saga-dash': WT_DASH } } },
    });
    installClaimReader({
      [STATE_S2]: claimResult({ actor: 'coach-aug3-training' }, true),
      [STATE_S4]: claimResult({ actor: 'claude:41234', actorSource: 'claude', slot: 4 }, false),
    });
    installGit({ branches: { [WT_DASH]: 'feat/x' } });
    installDirCheck([WT_DASH]);

    await StackSlots.run([...WS], config);
    const text = out.join('\n');

    // One row per active/claimed/set slot.
    expect(text).toMatch(/^0\s+● up\s+—\s+—/m); // active, no set, no claim
    expect(text).toMatch(/^2\s+● up\s+journey-fix\s+coach-aug3-training\s+2026-07-16T12:00:00\.000Z/m);
    expect(text).toMatch(/^4\s+—\s+—\s+claude:41234 \(stale\)/m); // dead pid ⇒ stale
    // The set-bound active slot postures its pinned repo.
    expect(text).toMatch(/saga-dash\s+@ feat\/x\s+\(clean\)/);
    // Slots with nothing collapse into ONE dim summary line.
    expect(text).toContain('slots 1, 3, 5, 6, 7, 8, 9: unused');
    expect(text.match(/unused/g)).toHaveLength(1);
  });

  it('nothing anywhere ⇒ a single idle note (and exit 0 — the command never fails)', async () => {
    await expect(StackSlots.run([...WS], config)).resolves.toBeUndefined();
    expect(out.join('\n')).toContain('No slots in use');
  });

  it('--output-json: pinned shape — claim null when absent, posture rows, postureSkipped for a set-less slot > 0', async () => {
    spySlotActive(['soa-s2', 'soa-s5']);
    spySetStore({
      version: 1,
      sets: { 'journey-fix': { slot: 2, repos: { 'saga-dash': WT_DASH } } },
    });
    installClaimReader({
      [STATE_S2]: claimResult({
        actor: 'coach-aug3-training',
        set: 'journey-fix',
        sourceAtLaunch: { 'saga-dash': { branch: 'feat/x', headSha: 'aaa111', dirty: false } },
      }),
      [STATE_S4]: claimResult({ actor: 'claude:41234', actorSource: 'claude', slot: 4 }, false),
    });
    installGit({
      branches: { [WT_DASH]: 'feat/x' },
      dirty: [WT_DASH],
      behind: { [WT_DASH]: 3 },
      heads: { [WT_DASH]: 'bbb222' }, // ≠ the claim's recorded launch HEAD ⇒ drifted
    });
    installDirCheck([WT_DASH]);

    await StackSlots.run([...WS, '--output-json'], config);
    const json = JSON.parse(out.join('\n'));

    expect(json.slots.map((s: { slot: number }) => s.slot)).toEqual([2, 4, 5]);

    const s2 = json.slots[0];
    expect(s2).toMatchObject({
      slot: 2,
      active: true,
      project: 'soa-s2',
      stateDir: STATE_S2,
      set: 'journey-fix',
      claim: {
        actor: 'coach-aug3-training',
        actorSource: 'env',
        live: true,
        at: '2026-07-16T12:00:00.000Z',
        pid: 41234,
        command: 'ss stack:up --slot 2',
        set: 'journey-fix',
      },
    });
    expect(s2.posture).toEqual([
      { repo: 'saga-dash', branch: 'feat/x', dirty: true, behind: 3, driftedSinceLaunch: true },
    ]);

    // Inactive claimed slot: claim carried (stale), posture skipped ⇒ [].
    const s4 = json.slots[1];
    expect(s4).toMatchObject({ slot: 4, active: false, set: null });
    expect(s4.claim).toMatchObject({ actor: 'claude:41234', live: false });
    expect(s4.posture).toEqual([]);

    // Active set-less slot > 0: no posture, an explicit reason instead.
    const s5 = json.slots[2];
    expect(s5).toMatchObject({ slot: 5, active: true, set: null, claim: null });
    expect(s5.posture).toEqual([]);
    expect(s5.postureSkipped).toBe('shared checkouts (see slot 0)');
  });

  it('porcelain: one stable TSV line per row-worthy slot, no color codes', async () => {
    spySlotActive(['soa-s2']);
    spySetStore({
      version: 1,
      sets: { 'journey-fix': { slot: 2, repos: { 'saga-dash': WT_DASH } } },
    });
    installClaimReader({
      [STATE_S2]: claimResult({ actor: 'coach-aug3-training' }),
      [STATE_S4]: claimResult({ actor: 'claude:41234', actorSource: 'claude', slot: 4 }, false),
    });
    installDirCheck([WT_DASH]);

    await StackSlots.run([...WS, '--porcelain'], config);

    expect(out).toEqual([
      '2\tactive\tjourney-fix\tcoach-aug3-training\tlive\t2026-07-16T12:00:00.000Z',
      '4\t-\t-\tclaude:41234\tstale\t2026-07-16T12:00:00.000Z',
    ]);
  });

  it('an active set-less slot > 0 postures NOTHING (zero git spawns; dim shared-checkouts note)', async () => {
    spySlotActive(['soa-s5']);

    await StackSlots.run([...WS], config);

    expect(gitCalls).toEqual([]); // cost control: no posture probes off-slot-0 without a set
    expect(out.join('\n')).toContain('shared checkouts (see slot 0)');
  });

  it('slot 0 active postures every shared checkout that EXISTS (missing roots skipped)', async () => {
    spySlotActive(['soa']);
    installGit({ branches: { [SOA_ROOT]: 'main', [DASH_ROOT]: 'feat/y' } });
    installDirCheck([SOA_ROOT, DASH_ROOT]); // the other 7 roots are absent ⇒ skipped

    await StackSlots.run([...WS, '--output-json'], config);
    const json = JSON.parse(out.join('\n'));

    const s0 = json.slots[0];
    expect(s0.slot).toBe(0);
    expect(s0.posture.map((p: { repo: string }) => p.repo).sort()).toEqual(['saga-dash', 'soa']);
    expect(s0.posture.find((p: { repo: string }) => p.repo === 'saga-dash')).toMatchObject({
      branch: 'feat/y',
      dirty: false,
      behind: 0,
      driftedSinceLaunch: false, // no claim ⇒ no recorded launch HEAD ⇒ never drifted
    });
  });
});
