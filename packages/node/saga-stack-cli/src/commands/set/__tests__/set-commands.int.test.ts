/**
 * `set list` / `set show` / `set check` (M13-A, plan §2.4) — in-process, every
 * seam faked: set store (canned), slot-activity probe (canned), git runner
 * (canned branches), fresh-check (pinned buildable/prebuilt). Real fs only for
 * mkdtemp worktree stand-ins.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { parseWorktreeSetsFile } from '../../../core/set/index.js';
import type { GitRunner, SetStore, SlotActiveProbe } from '../../../runtime/index.js';
import SetCheck from '../check.js';
import SetList from '../list.js';
import SetShow from '../show.js';

/** Pin the activity probe INACTIVE so no test ever consults docker/state dirs. */
function spyInactiveProbe(): void {
  const probe: SlotActiveProbe = { isActive: async () => false };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSlotActiveProbe: () => SlotActiveProbe },
    'getSlotActiveProbe',
  ).mockReturnValue(probe);
}

const PKG_ROOT = process.cwd();

let config: Config;
let dir: string;
let logged: string[];

function storeOf(data: unknown): SetStore {
  return { path: () => '/canned/worktree-sets.json', load: () => parseWorktreeSetsFile(data) };
}

function spyStore(data: unknown): void {
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSetStore: () => SetStore },
    'getSetStore',
  ).mockReturnValue(storeOf(data));
}

function spyGit(branches: Record<string, string>, opts: { porcelain?: string; nonCheckouts?: string[] } = {}): void {
  const fake: Partial<GitRunner> = {
    branchShowCurrent: async (repoPath: string) => branches[repoPath] ?? 'main',
    statusPorcelain: async () => opts.porcelain ?? '',
    revParseVerify: async (repoPath: string) => !(opts.nonCheckouts ?? []).includes(repoPath),
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getGitRunner: () => GitRunner },
    'getGitRunner',
  ).mockReturnValue(fake as GitRunner);
}

function spyFresh(prebuilt: boolean): void {
  vi.spyOn(
    BaseCommand.prototype as unknown as { getPrepFreshCheck: () => (root: string) => boolean },
    'getPrepFreshCheck',
  ).mockReturnValue(() => prebuilt);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  dir = mkdtempSync(join(tmpdir(), 'set-cmds-'));
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
    logged.push(String(m ?? ''));
  });
  spyInactiveProbe();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('set list', () => {
  it('renders name/slot/ACTIVE/repos, ACTIVE derived live per slot', async () => {
    spyStore({
      version: 1,
      sets: {
        'journey-fix': { slot: 1, repos: { 'saga-dash': '/wt/dash-j' }, note: 'PR #345' },
        topology: { slot: 2, repos: { 'saga-dash': '/wt/dash-t', rostering: '/wt/rost-c' } },
      },
    });
    const probe: SlotActiveProbe = { isActive: async (_state, project) => project === 'soa-s1' };
    vi.spyOn(
      SetList.prototype as unknown as { getSlotActiveProbe: () => SlotActiveProbe },
      'getSlotActiveProbe',
    ).mockReturnValue(probe);

    await SetList.run([], config);
    const out = logged.join('\n');
    expect(out).toMatch(/journey-fix.*1.*● up.*saga-dash.*PR #345/);
    expect(out).toMatch(/topology.*2.*—.*saga-dash, rostering/);
  });

  it('an empty store points at the sets file', async () => {
    spyStore({ version: 1, sets: {} });
    await SetList.run([], config);
    expect(logged.join('\n')).toMatch(/No worktree sets defined in \/canned\/worktree-sets\.json/);
  });
});

describe('set show', () => {
  it('shows live branch + dirty state + provenance per repo', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spyStore({
      version: 1,
      sets: {
        x: {
          slot: 1,
          repos: {
            'saga-dash': { path: dash, createdBy: 'ss', createdFrom: 'feat/x' },
            rostering: join(dir, 'missing-rostering'),
          },
        },
      },
    });
    spyGit({ [dash]: 'feat/x' });

    await SetShow.run(['x'], config);
    const out = logged.join('\n');
    expect(out).toMatch(/x — slot 1/);
    expect(out).toMatch(/✓ saga-dash.*@ feat\/x \(clean\).*created from feat\/x/);
    expect(out).toMatch(/✗ rostering.*\(missing\)/);
  });

  it('unknown set name errors with the known names', async () => {
    spyStore({ version: 1, sets: { x: { slot: 1, repos: {} } } });
    await expect(SetShow.run(['nope'], config)).rejects.toThrow(/unknown set 'nope'/);
  });

  it('an existing NON-git dir renders (not a git checkout), never a clean detached HEAD', async () => {
    const plainDir = join(dir, 'plain');
    mkdirSync(plainDir);
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': plainDir } } } });
    spyGit({}, { nonCheckouts: [plainDir] });

    await SetShow.run(['x'], config);
    const out = logged.join('\n');
    expect(out).toMatch(/✗ saga-dash.*\(not a git checkout\)/);
    expect(out).not.toMatch(/detached/);
  });
});

describe('set check', () => {
  it('a clean pre-built set is OK (exit 0)', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': dash } } } });
    spyGit({ [dash]: 'feat/x' });
    spyFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/✓ x: OK/);
  });

  it('a missing path is a violation (exit 1)', async () => {
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': join(dir, 'nope') } } } });
    spyGit({});
    spyFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(logged.join('\n')).toMatch(/path does not exist/);
  });

  it('branch drift against createdFrom WARNS but never blocks', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spyStore({
      version: 1,
      sets: { x: { slot: 1, repos: { 'saga-dash': { path: dash, createdBy: 'ss', createdFrom: 'feat/x' } } } },
    });
    spyGit({ [dash]: 'feat/OTHER' });
    spyFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/⚠ branch drift: @ feat\/OTHER, created from feat\/x/);
  });

  it('a BUILDABLE entry at the primary checkout is a violation; pre-built only warns', async () => {
    const devRoot = join(dir, 'dev');
    const primaryDash = join(devRoot, 'saga-dash');
    mkdirSync(primaryDash, { recursive: true });
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': primaryDash } } } });
    spyGit({ [primaryDash]: 'main' });

    spyFresh(false);
    await expect(SetCheck.run(['x', '--dev', devRoot], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
    expect(logged.join('\n')).toMatch(/BUILDABLE entry points at the primary checkout/);

    logged.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
      logged.push(String(m ?? ''));
    });
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': primaryDash } } } });
    spyGit({ [primaryDash]: 'main' });
    spyFresh(true);
    await expect(SetCheck.run(['x', '--dev', devRoot], config)).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/⚠ points at the primary checkout/);
  });

  it('two sets sharing one BUILDABLE checkout is a cross-set collision (exit 1)', async () => {
    const shared = join(dir, 'shared-rostering');
    mkdirSync(shared);
    spyStore({
      version: 1,
      sets: {
        a: { slot: 1, repos: { rostering: shared } },
        b: { slot: 2, repos: { rostering: shared } },
      },
    });
    spyGit({ [shared]: 'main' });
    spyFresh(false);

    await expect(SetCheck.run(['a', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(logged.join('\n')).toMatch(/build collision: set 'b' rostering shares this BUILDABLE checkout/);
  });

  it('--porcelain stays tab-separated and attributes a collision to its repo row', async () => {
    const shared = join(dir, 'shared-rostering');
    mkdirSync(shared);
    spyStore({
      version: 1,
      sets: {
        a: { slot: 1, repos: { rostering: shared } },
        b: { slot: 2, repos: { rostering: shared } },
      },
    });
    spyGit({ [shared]: 'main' });
    spyFresh(false);

    await expect(SetCheck.run(['a', '--porcelain', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    // Every line is a tab-separated machine row; the collision shows on the
    // rostering row's status, not as loose human prose.
    expect(logged).not.toHaveLength(0);
    for (const line of logged) expect(line).toMatch(/^[a-z-]+\t(ok|violation)\t\d+$/);
    expect(logged).toContain('rostering\tviolation\t0');
  });

  it('an existing NON-git dir is a check violation (exit 1), not a green detached row', async () => {
    const plainDir = join(dir, 'plain');
    mkdirSync(plainDir);
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': plainDir } } } });
    spyGit({}, { nonCheckouts: [plainDir] });
    spyFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(logged.join('\n')).toMatch(/is not a git checkout/);
  });
});
