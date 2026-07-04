/**
 * M13-B implicit set preflight (BaseCommand.runSetPreflight — wired into
 * `stack up --set` and `e2e run --set`): violations hard-error BEFORE any
 * stack mutation; `--allow-primary` downgrades the primary-checkout refusal
 * to a warning; the cross-set collision is sharpened with live ACTIVE-slot
 * detection. Exercised through a zero-IO probe command (parse + preflight
 * only) plus the real `e2e run` (whose preflight fires before any discovery).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, Flags } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { parseWorktreeSetsFile } from '../../../core/set/index.js';
import type { GitRunner, SetStore, SlotActiveProbe } from '../../../runtime/index.js';
import E2eRun from '../../e2e/run.js';

const PKG_ROOT = process.cwd();

/** Zero-IO probe: parse + the M13-B preflight, nothing else. */
class PreflightProbe extends BaseCommand {
  static flags = {
    ...BaseCommand.baseFlags,
    'allow-primary': Flags.boolean({ default: false }),
  };

  protected slotAware(): boolean {
    return true;
  }

  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(PreflightProbe);
    await this.runSetPreflight(flags);
  }
}

let config: Config;
let dir: string;
let logged: string[];

function spyStore(data: unknown): void {
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSetStore: () => SetStore },
    'getSetStore',
  ).mockReturnValue({ path: () => '/canned/sets.json', load: () => parseWorktreeSetsFile(data) });
}

function spyGit(nonCheckouts: string[] = []): void {
  const fake: Partial<GitRunner> = {
    branchShowCurrent: async () => 'main',
    statusPorcelain: async () => '',
    revParseVerify: async (repoPath: string) => !nonCheckouts.includes(repoPath),
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

function spyActive(activeProjects: string[]): void {
  const probe: SlotActiveProbe = { isActive: async (_s, project) => activeProjects.includes(project) };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSlotActiveProbe: () => SlotActiveProbe },
    'getSlotActiveProbe',
  ).mockReturnValue(probe);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  dir = mkdtempSync(join(tmpdir(), 'set-preflight-'));
  logged = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m) => {
    logged.push(String(m ?? ''));
  });
  spyActive([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('runSetPreflight violations', () => {
  it('a missing path hard-errors before anything runs', async () => {
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': join(dir, 'nope') } } } });
    spyGit();
    spyFresh(true);
    await expect(PreflightProbe.run(['--set', 'x', '--dev', join(dir, 'dev')], config)).rejects.toThrow(
      /failed the preflight check[\s\S]*path does not exist/,
    );
  });

  it('a BUILDABLE entry at the primary checkout is refused — --allow-primary downgrades to a warning', async () => {
    const devRoot = join(dir, 'dev');
    const primary = join(devRoot, 'saga-dash');
    mkdirSync(primary, { recursive: true });
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': primary } } } });
    spyGit();
    spyFresh(false);

    await expect(PreflightProbe.run(['--set', 'x', '--dev', devRoot], config)).rejects.toThrow(
      /BUILDABLE entry points at the primary checkout/,
    );

    await expect(
      PreflightProbe.run(['--set', 'x', '--dev', devRoot, '--allow-primary'], config),
    ).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/⚠ set x\/saga-dash: BUILDABLE entry at the primary checkout — allowed/);
  });

  it('a cross-set buildable collision names the other set — and flags it ACTIVE when its slot is live', async () => {
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    spyStore({
      version: 1,
      sets: {
        a: { slot: 1, repos: { rostering: shared } },
        b: { slot: 2, repos: { rostering: shared } },
      },
    });
    spyGit();
    spyFresh(false);
    spyActive(['soa-s2']); // set b's slot is LIVE

    await expect(PreflightProbe.run(['--set', 'a', '--dev', join(dir, 'dev')], config)).rejects.toThrow(
      /build collision: set 'b' rostering[\s\S]*slot 2\) is ACTIVE right now/,
    );
  });

  it('no --set = no-op (nothing loaded, nothing logged)', async () => {
    // Store spy intentionally NOT installed: a load would throw on real fs read
    // of a nonexistent canned path — the no-op must never get that far.
    spyGit();
    spyFresh(true);
    await expect(PreflightProbe.run(['--dev', join(dir, 'dev')], config)).resolves.toBeUndefined();
  });
});

describe('e2e run --set runs the preflight before discovery', () => {
  it('a violating set fails e2e run up front', async () => {
    spyStore({ version: 1, sets: { x: { slot: 1, repos: { 'saga-dash': join(dir, 'nope') } } } });
    spyGit();
    spyFresh(true);
    await expect(
      E2eRun.run(['saga-dash/journey', '--set', 'x', '--dev', join(dir, 'dev')], config),
    ).rejects.toThrow(/failed the preflight check/);
  });
});
