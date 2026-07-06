/**
 * `set list` / `set show` / `set check` (M13-A, plan §2.4) — in-process, every
 * seam faked via the shared set-fakes helpers: set store (canned), slot-activity
 * probe (canned), git runner (canned branches), fresh-check (pinned
 * buildable/prebuilt). Real fs only for mkdtemp worktree stand-ins.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  oneSetWithSagaDash,
  spyGitRunner,
  spyPrepFresh,
  spySetStore,
  spySlotActive,
  twoSetsSharingCheckout,
} from '../../../__tests__/helpers/set-fakes.js';
import { BaseCommand } from '../../../base-command.js';
import SetCheck from '../check.js';
import SetList from '../list.js';
import SetShow from '../show.js';

const PKG_ROOT = process.cwd();

let config: Config;
let dir: string;
let logged: string[];

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  dir = mkdtempSync(join(tmpdir(), 'set-cmds-'));
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
    logged.push(String(m ?? ''));
  });
  // Pin the activity probe INACTIVE so no test ever consults docker/state dirs.
  spySlotActive([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('set list', () => {
  it('renders name/slot/ACTIVE/repos, ACTIVE derived live per slot', async () => {
    spySetStore({
      version: 1,
      sets: {
        'journey-fix': { slot: 1, repos: { 'saga-dash': '/wt/dash-j' }, note: 'PR #345' },
        topology: { slot: 2, repos: { 'saga-dash': '/wt/dash-t', rostering: '/wt/rost-c' } },
      },
    });
    spySlotActive(['soa-s1']);

    await SetList.run([], config);
    const out = logged.join('\n');
    expect(out).toMatch(/journey-fix.*1.*● up.*saga-dash.*PR #345/);
    expect(out).toMatch(/topology.*2.*—.*saga-dash, rostering/);
  });

  it('an empty store points at the sets file', async () => {
    spySetStore({ version: 1, sets: {} });
    await SetList.run([], config);
    expect(logged.join('\n')).toMatch(/No worktree sets defined in \/canned\/worktree-sets\.json/);
  });
});

describe('set show', () => {
  it('shows live branch + dirty state + provenance per repo', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spySetStore({
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
    spyGitRunner({ branches: { [dash]: 'feat/x' } });

    await SetShow.run(['x'], config);
    const out = logged.join('\n');
    expect(out).toMatch(/x — slot 1/);
    expect(out).toMatch(/✓ saga-dash.*@ feat\/x \(clean\).*created from feat\/x/);
    expect(out).toMatch(/✗ rostering.*\(missing\)/);
  });

  it('unknown set name errors with the known names', async () => {
    spySetStore({ version: 1, sets: { x: { slot: 1, repos: {} } } });
    await expect(SetShow.run(['nope'], config)).rejects.toThrow(/unknown set 'nope'/);
  });

  it('an existing NON-git dir renders (not a git checkout), never a clean detached HEAD', async () => {
    const plainDir = join(dir, 'plain');
    mkdirSync(plainDir);
    spySetStore(oneSetWithSagaDash(plainDir));
    spyGitRunner({ nonCheckouts: [plainDir] });

    await SetShow.run(['x'], config);
    const out = logged.join('\n');
    expect(out).toMatch(/✗ saga-dash.*\(not a git checkout\)/);
    expect(out).not.toMatch(/detached/);
  });
});

describe('set show — mainline currency', () => {
  it('reports [includes origin/main] when the worktree contains the main tip', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spySetStore(oneSetWithSagaDash(dash));
    spyGitRunner({ branches: { [dash]: 'feat/x' } });

    await SetShow.run(['x'], config);
    expect(logged.join('\n')).toMatch(/\[includes origin\/main\]/);
  });

  it('warns with the behind count when the worktree lacks the main tip', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spySetStore(oneSetWithSagaDash(dash));
    spyGitRunner({ branches: { [dash]: 'feat/x' }, behindMain: { [dash]: 7 } });

    await SetShow.run(['x'], config);
    expect(logged.join('\n')).toMatch(/\[⚠ behind origin\/main by 7 — merge up\]/);
  });

  it('projects mainRef/includesMain/behindMain into --output-json', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spySetStore(oneSetWithSagaDash(dash));
    spyGitRunner({ behindMain: { [dash]: 3 } });

    await SetShow.run(['x', '--output-json'], config);
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed.repos[0]).toMatchObject({ mainRef: 'origin/main', includesMain: false, behindMain: 3 });
  });
});

describe('set check', () => {
  it('a clean pre-built set is OK (exit 0)', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spySetStore(oneSetWithSagaDash(dash));
    spyGitRunner({ branches: { [dash]: 'feat/x' } });
    spyPrepFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/✓ x: OK/);
  });

  it('a missing path is a violation (exit 1)', async () => {
    spySetStore(oneSetWithSagaDash(join(dir, 'nope')));
    spyGitRunner();
    spyPrepFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(logged.join('\n')).toMatch(/path does not exist/);
  });

  it('branch drift against createdFrom WARNS but never blocks', async () => {
    const dash = join(dir, 'dash');
    mkdirSync(dash);
    spySetStore({
      version: 1,
      sets: { x: { slot: 1, repos: { 'saga-dash': { path: dash, createdBy: 'ss', createdFrom: 'feat/x' } } } },
    });
    spyGitRunner({ branches: { [dash]: 'feat/OTHER' } });
    spyPrepFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/⚠ branch drift: @ feat\/OTHER, created from feat\/x/);
  });

  it('a BUILDABLE entry at the primary checkout is a violation; pre-built only warns', async () => {
    const devRoot = join(dir, 'dev');
    const primaryDash = join(devRoot, 'saga-dash');
    mkdirSync(primaryDash, { recursive: true });
    spySetStore(oneSetWithSagaDash(primaryDash));
    spyGitRunner({ branches: { [primaryDash]: 'main' } });

    spyPrepFresh(false);
    await expect(SetCheck.run(['x', '--dev', devRoot], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
    expect(logged.join('\n')).toMatch(/BUILDABLE entry points at the primary checkout/);

    logged.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
      logged.push(String(m ?? ''));
    });
    spySetStore(oneSetWithSagaDash(primaryDash));
    spyGitRunner({ branches: { [primaryDash]: 'main' } });
    spyPrepFresh(true);
    await expect(SetCheck.run(['x', '--dev', devRoot], config)).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/⚠ points at the primary checkout/);
  });

  it('two sets sharing one BUILDABLE checkout is a cross-set collision (exit 1)', async () => {
    const shared = join(dir, 'shared-rostering');
    mkdirSync(shared);
    spySetStore(twoSetsSharingCheckout(shared));
    spyGitRunner({ branches: { [shared]: 'main' } });
    spyPrepFresh(false);

    await expect(SetCheck.run(['a', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(logged.join('\n')).toMatch(/build collision: set 'b' rostering shares this BUILDABLE checkout/);
  });

  it('--porcelain stays tab-separated and attributes a collision to its repo row', async () => {
    const shared = join(dir, 'shared-rostering');
    mkdirSync(shared);
    spySetStore(twoSetsSharingCheckout(shared));
    spyGitRunner({ branches: { [shared]: 'main' } });
    spyPrepFresh(false);

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
    spySetStore(oneSetWithSagaDash(plainDir));
    spyGitRunner({ nonCheckouts: [plainDir] });
    spyPrepFresh(true);

    await expect(SetCheck.run(['x', '--dev', join(dir, 'dev')], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(logged.join('\n')).toMatch(/is not a git checkout/);
  });
});
