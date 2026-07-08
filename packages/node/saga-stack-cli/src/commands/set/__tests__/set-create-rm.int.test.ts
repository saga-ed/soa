/**
 * `set create` / `set rm` (M13-C) — in-process, seams faked on BaseCommand.prototype:
 * the set store (in-memory, capturing `save`), the git runner (`worktreeAdd`/
 * `worktreeRemove`/`revParseVerify`), and the pnpm Runner. Real fs only for the primary
 * checkout's `.git` (create's existence gate) and the worktree-path collision gate.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { parseWorktreeSetsFile, type WorktreeSetsFile } from '../../../core/set/index.js';
import type { GitRunner, SetStore } from '../../../runtime/index.js';
import type { Runner, ScriptInvocation } from '../../../runtime/exec.js';
import SetCreate from '../create.js';
import SetRm from '../rm.js';

const PKG_ROOT = process.cwd();
let config: Config;
let dir: string;
let devRoot: string;
let saved: WorktreeSetsFile | null;
let gitCalls: { verb: string; args: unknown[] }[];
let runCalls: ScriptInvocation[];

const empty = (): WorktreeSetsFile => parseWorktreeSetsFile({ version: 1, sets: {} });
const primary = (): string => join(devRoot, 'saga-dash');

function installStore(initial: WorktreeSetsFile): void {
  let current = initial;
  saved = null;
  const store: SetStore = {
    path: () => join(dir, 'sets.json'),
    load: () => current,
    loadRaw: () => current,
    save: (f) => {
      current = f;
      saved = f;
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getSetStore: () => SetStore }, 'getSetStore').mockReturnValue(store);
}

function installGit(
  opts: { branchExists?: boolean; addOk?: boolean; addErr?: string; removeOk?: boolean; removeErr?: string } = {},
): void {
  const fake: Partial<GitRunner> = {
    revParseVerify: async () => opts.branchExists ?? false,
    worktreeAdd: async (repoPath, worktreePath, ref, o) => {
      gitCalls.push({ verb: 'add', args: [repoPath, worktreePath, ref, o] });
      return { ok: opts.addOk ?? true, stderr: opts.addErr ?? '' };
    },
    worktreeRemove: async (repoPath, worktreePath, o) => {
      gitCalls.push({ verb: 'remove', args: [repoPath, worktreePath, o] });
      return { ok: opts.removeOk ?? true, stderr: opts.removeErr ?? '' };
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getGitRunner: () => GitRunner }, 'getGitRunner').mockReturnValue(fake as GitRunner);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  dir = mkdtempSync(join(tmpdir(), 'set-crud-'));
  devRoot = join(dir, 'dev');
  mkdirSync(join(devRoot, 'saga-dash', '.git'), { recursive: true }); // the primary checkout
  gitCalls = [];
  runCalls = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
  const runner: Runner = {
    async run(spec) {
      runCalls.push(spec);
      return { code: 0 };
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getRunner: () => Runner }, 'getRunner').mockReturnValue(runner);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('set create', () => {
  it('worktree-adds a NEW branch off the primary and records the set (createdBy ss, createdFrom)', async () => {
    installStore(empty());
    installGit({ branchExists: false });
    const wt = join(dir, 'wt-dash');
    await SetCreate.run(
      ['sched', '--slot', '1', '--repo', 'saga-dash', '--path', wt, '--branch', 'feat/x', '--dev', devRoot, '--no-install'],
      config,
    );
    expect(gitCalls).toEqual([{ verb: 'add', args: [primary(), wt, 'feat/x', { newBranch: true, startPoint: undefined }] }]);
    expect(saved!.sets.sched!.slot).toBe(1);
    expect(saved!.sets.sched!.repos['saga-dash']).toEqual({ path: wt, createdBy: 'ss', createdFrom: 'feat/x' });
    expect(runCalls).toHaveLength(0); // --no-install
  });

  it('defaults the branch to the set name and runs pnpm install in the worktree', async () => {
    installStore(empty());
    installGit({ branchExists: false });
    const wt = join(dir, 'wt-dash');
    await SetCreate.run(['sched', '--slot', '1', '--repo', 'saga-dash', '--path', wt, '--dev', devRoot], config);
    expect(saved!.sets.sched!.repos['saga-dash']!.createdFrom).toBe('sched'); // default branch = name
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.cwd).toBe(wt);
    expect(runCalls[0]!.args).toEqual(['install']);
  });

  it('attaches an EXISTING branch (no -b)', async () => {
    installStore(empty());
    installGit({ branchExists: true });
    const wt = join(dir, 'wt-dash');
    await SetCreate.run(
      ['sched', '--slot', '1', '--repo', 'saga-dash', '--path', wt, '--branch', 'existing', '--dev', devRoot, '--no-install'],
      config,
    );
    expect(gitCalls[0]!.args[3]).toEqual({ newBranch: false, startPoint: undefined });
  });

  it('passes --base as the start point for a new branch', async () => {
    installStore(empty());
    installGit({ branchExists: false });
    const wt = join(dir, 'wt-dash');
    await SetCreate.run(
      ['sched', '--slot', '1', '--repo', 'saga-dash', '--path', wt, '--branch', 'feat/x', '--base', 'main', '--dev', devRoot, '--no-install'],
      config,
    );
    expect(gitCalls[0]!.args[3]).toEqual({ newBranch: true, startPoint: 'main' });
  });

  it('rejects slot 0', async () => {
    installStore(empty());
    installGit();
    await expect(
      SetCreate.run(['s', '--slot', '0', '--repo', 'saga-dash', '--path', join(dir, 'wt'), '--dev', devRoot, '--no-install'], config),
    ).rejects.toThrow(/--slot must be 1..9/);
  });

  it('rejects a duplicate set name (before touching git)', async () => {
    installStore(parseWorktreeSetsFile({ version: 1, sets: { sched: { slot: 2, repos: { rostering: '/wt/r' } } } }));
    installGit();
    await expect(
      SetCreate.run(['sched', '--slot', '1', '--repo', 'saga-dash', '--path', join(dir, 'wt'), '--dev', devRoot, '--no-install'], config),
    ).rejects.toThrow(/already exists/);
    expect(gitCalls).toHaveLength(0);
  });

  it('rejects a slot already owned', async () => {
    installStore(parseWorktreeSetsFile({ version: 1, sets: { other: { slot: 1, repos: { rostering: '/wt/r' } } } }));
    installGit();
    await expect(
      SetCreate.run(['sched', '--slot', '1', '--repo', 'saga-dash', '--path', join(dir, 'wt'), '--dev', devRoot, '--no-install'], config),
    ).rejects.toThrow(/slot 1 is already owned/);
  });

  it('rejects when the worktree path already exists', async () => {
    installStore(empty());
    installGit();
    const wt = join(dir, 'exists');
    mkdirSync(wt);
    await expect(
      SetCreate.run(['sched', '--slot', '1', '--repo', 'saga-dash', '--path', wt, '--dev', devRoot, '--no-install'], config),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects when the primary checkout is missing', async () => {
    installStore(empty());
    installGit();
    const emptyDev = join(dir, 'emptydev');
    mkdirSync(emptyDev);
    await expect(
      SetCreate.run(['sched', '--slot', '1', '--repo', 'saga-dash', '--path', join(dir, 'wt'), '--dev', emptyDev, '--no-install'], config),
    ).rejects.toThrow(/primary checkout for 'saga-dash' not found/);
  });

  it('surfaces a git worktree add failure (and does not record the set)', async () => {
    installStore(empty());
    installGit({ addOk: false, addErr: "fatal: 'x' already checked out" });
    await expect(
      SetCreate.run(['sched', '--slot', '1', '--repo', 'saga-dash', '--path', join(dir, 'wt'), '--dev', devRoot, '--no-install'], config),
    ).rejects.toThrow(/git worktree add failed.*already checked out/);
    expect(saved).toBeNull();
  });
});

describe('set rm', () => {
  const oneSsSet = (): WorktreeSetsFile =>
    parseWorktreeSetsFile({
      version: 1,
      sets: { sched: { slot: 1, repos: { 'saga-dash': { path: '/wt/dash', createdBy: 'ss', createdFrom: 'feat/x' } } } },
    });

  it('drops only the set entry by default (worktrees left on disk)', async () => {
    installStore(oneSsSet());
    installGit();
    await SetRm.run(['sched', '--dev', devRoot], config);
    expect(gitCalls).toHaveLength(0);
    expect(saved!.sets.sched).toBeUndefined();
  });

  it('--and-worktrees --yes removes the ss-created worktree and the set', async () => {
    installStore(oneSsSet());
    installGit();
    await SetRm.run(['sched', '--and-worktrees', '--yes', '--dev', devRoot], config);
    expect(gitCalls).toEqual([{ verb: 'remove', args: [primary(), '/wt/dash', { force: false }] }]);
    expect(saved!.sets.sched).toBeUndefined();
  });

  it('passes --force through to git worktree remove', async () => {
    installStore(oneSsSet());
    installGit();
    await SetRm.run(['sched', '--and-worktrees', '--yes', '--force', '--dev', devRoot], config);
    expect(gitCalls[0]!.args[2]).toEqual({ force: true });
  });

  it('--and-worktrees without --yes errors (destructive)', async () => {
    installStore(oneSsSet());
    installGit();
    await expect(SetRm.run(['sched', '--and-worktrees', '--dev', devRoot], config)).rejects.toThrow(/re-run with --yes/);
  });

  it('NEVER removes a hand-recorded (non-ss) worktree, but still drops the set', async () => {
    installStore(parseWorktreeSetsFile({ version: 1, sets: { sched: { slot: 1, repos: { 'saga-dash': '/wt/hand' } } } }));
    installGit();
    await SetRm.run(['sched', '--and-worktrees', '--yes', '--dev', devRoot], config);
    expect(gitCalls).toHaveLength(0); // skipped — not createdBy ss
    expect(saved!.sets.sched).toBeUndefined();
  });

  it('unknown set errors', async () => {
    installStore(empty());
    installGit();
    await expect(SetRm.run(['nope', '--dev', devRoot], config)).rejects.toThrow(/unknown set 'nope'/);
  });
});
