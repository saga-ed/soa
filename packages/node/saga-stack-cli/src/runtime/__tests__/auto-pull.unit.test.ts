/**
 * auto-pull ORCHESTRATOR unit tests (M9; up.sh `pull_repos`).
 *
 * Drive `autoPullRepos` with a FAKE `GitRunner` + a fake `.git` existence predicate —
 * no real git/network/fs. Assert: the skip/ff decision per up.sh state, that a FETCH
 * FAILURE warns-and-continues (never aborts), that `auto` mode leaves off-default
 * branches, and that an on-default clean-behind repo gets fast-forwarded (the one
 * mutating `merge --ff-only`).
 */

import { describe, expect, it, vi } from 'vitest';
import { autoPullRepos } from '../auto-pull.js';
import { hasTrackedChanges } from '../git.js';
import type { GitRunner } from '../git.js';

/** A scriptable fake git seam keyed by repo path. */
interface RepoState {
  porcelain?: string;
  branch?: string;
  defaultBranch?: string;
  fetchOk?: boolean;
  hasUpstream?: boolean;
  behind?: number;
  ffOk?: boolean;
}

function fakeGit(byPath: Record<string, RepoState>): { git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const s = (p: string): RepoState => byPath[p] ?? {};
  const git: GitRunner = {
    async statusPorcelain(p) {
      calls.push(`status ${p}`);
      return s(p).porcelain ?? '';
    },
    async branchShowCurrent(p) {
      calls.push(`branch ${p}`);
      return s(p).branch ?? 'main';
    },
    async symbolicRefDefault(p) {
      calls.push(`symref ${p}`);
      return s(p).defaultBranch ?? 'main';
    },
    async fetch(p) {
      calls.push(`fetch ${p}`);
      return s(p).fetchOk ?? true;
    },
    async hasUpstream(p) {
      calls.push(`upstream ${p}`);
      return s(p).hasUpstream ?? true;
    },
    async revListCount(p) {
      calls.push(`behind ${p}`);
      return s(p).behind ?? 0;
    },
    async mergeFfOnly(p) {
      calls.push(`ff ${p}`);
      return s(p).ffOk ?? true;
    },
  };
  return { git, calls };
}

const REPO = { name: 'program-hub', path: '/dev/program-hub' };

describe('hasTrackedChanges', () => {
  it('true only for a non-`??` porcelain line', () => {
    expect(hasTrackedChanges('')).toBe(false);
    expect(hasTrackedChanges('?? new-file\n?? other')).toBe(false); // untracked-only ⇒ not dirty
    expect(hasTrackedChanges(' M src/x.ts')).toBe(true);
    expect(hasTrackedChanges('?? a\n M b')).toBe(true);
  });
});

describe('autoPullRepos', () => {
  it('on-default, clean, behind ⇒ FAST-FORWARDED (the one mutating merge)', async () => {
    const { git, calls } = fakeGit({
      '/dev/program-hub': { branch: 'main', defaultBranch: 'main', hasUpstream: true, behind: 4, ffOk: true },
    });
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => true });
    expect(res.repos[0]).toMatchObject({ name: 'program-hub', action: 'ff', behind: 4 });
    expect(res.repos[0].message).toContain('fast-forwarded 4');
    expect(calls).toContain('ff /dev/program-hub'); // the merge ran
  });

  it('a FETCH FAILURE warns-and-continues (skip, never throws) and does NOT ff', async () => {
    const { git, calls } = fakeGit({
      '/dev/program-hub': { branch: 'main', defaultBranch: 'main', fetchOk: false },
    });
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => true });
    expect(res.repos[0]).toMatchObject({ action: 'skip', reason: 'fetch-failed' });
    expect(calls).not.toContain('upstream /dev/program-hub'); // short-circuited after the failed fetch
    expect(calls).not.toContain('ff /dev/program-hub');
  });

  it('not-cloned ⇒ skip WITHOUT touching git', async () => {
    const { git, calls } = fakeGit({});
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => false });
    expect(res.repos[0]).toMatchObject({ action: 'skip', reason: 'not-cloned' });
    expect(calls).toEqual([]); // no git ran on a non-repo
  });

  it('dirty tracked tree ⇒ skip, no fetch', async () => {
    const { git, calls } = fakeGit({ '/dev/program-hub': { porcelain: ' M src/x.ts', branch: 'main' } });
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => true });
    expect(res.repos[0]).toMatchObject({ action: 'skip', reason: 'dirty' });
    expect(calls).not.toContain('fetch /dev/program-hub');
  });

  it('auto mode LEAVES an off-default (overlay) branch untouched — never fetches it', async () => {
    const { git, calls } = fakeGit({
      '/dev/program-hub': { branch: 'local/integration', defaultBranch: 'main' },
    });
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => true });
    expect(res.repos[0].action).toBe('leave');
    expect(calls).not.toContain('fetch /dev/program-hub');
  });

  it('behind but merge --ff-only fails ⇒ diverged (skip by hand), reported not ff', async () => {
    const { git } = fakeGit({
      '/dev/program-hub': { branch: 'main', defaultBranch: 'main', hasUpstream: true, behind: 2, ffOk: false },
    });
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => true });
    expect(res.repos[0].action).toBe('diverged');
    expect(res.repos[0].message).toContain('diverged');
  });

  it('up to date (behind 0) ⇒ up-to-date, no merge', async () => {
    const { git, calls } = fakeGit({
      '/dev/program-hub': { branch: 'main', defaultBranch: 'main', hasUpstream: true, behind: 0 },
    });
    const res = await autoPullRepos({ repos: [REPO], mode: 'auto', git, pathExists: () => true });
    expect(res.repos[0].action).toBe('up-to-date');
    expect(calls).not.toContain('ff /dev/program-hub');
  });
});
