/**
 * repos-to-main unit tests (cold-start).
 *
 * The PURE `classifyRepo` decides switch/sync/skip; the orchestrator applies it through a FAKE
 * GitRunner (no real repo). Cover: on-default+behind ⇒ pulled; feature-branch ⇒ switched+pulled;
 * DIRTY ⇒ skipped-dirty and NEVER checked out (the safety invariant); missing ⇒ skipped-missing;
 * a failed checkout ⇒ error.
 */

import { describe, expect, it } from 'vitest';
import { classifyRepo, reposToMain } from '../repos-to-main.js';
import type { GitRunner } from '../git.js';
import type { EnsureRepo } from '../ensure-repos.js';

const repo = (name: string): EnsureRepo => ({
  name,
  path: `/dev/${name}`,
  url: `git@github.com:saga-ed/${name}.git`,
});

/** A GitRunner whose behaviour is keyed by repoPath, with safe defaults. */
function makeFakeGit(
  perRepo: Record<
    string,
    Partial<{
      branch: string;
      def: string;
      porcelain: string;
      checkoutOk: boolean;
      ffOk: boolean;
    }>
  >,
  spy?: { checkedOut: string[] },
): GitRunner {
  const g = (p: string) => perRepo[p] ?? {};
  const base = {
    async fetch() {
      return true;
    },
    async symbolicRefDefault(p: string) {
      return g(p).def ?? 'main';
    },
    async branchShowCurrent(p: string) {
      return g(p).branch ?? 'main';
    },
    async statusPorcelain(p: string) {
      return g(p).porcelain ?? '';
    },
    async checkout(p: string, ref: string) {
      spy?.checkedOut.push(`${p}:${ref}`);
      return g(p).checkoutOk ?? true;
    },
    async mergeFfOnly(p: string) {
      return g(p).ffOk ?? true;
    },
  };
  // The rest of the GitRunner surface is unused here — stub it so the type is satisfied.
  return new Proxy(base as unknown as GitRunner, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      return async () => false;
    },
  });
}

describe('classifyRepo — pure decision', () => {
  it('dirty ⇒ no switch, no sync', () => {
    expect(classifyRepo({ defaultBranch: 'main', currentBranch: 'feat/x', dirty: true })).toEqual({
      switchNeeded: false,
      syncAllowed: false,
      dirty: true,
    });
  });
  it('clean + off default ⇒ switch + sync', () => {
    expect(classifyRepo({ defaultBranch: 'main', currentBranch: 'feat/x', dirty: false })).toEqual({
      switchNeeded: true,
      syncAllowed: true,
      dirty: false,
    });
  });
  it('clean + on default ⇒ no switch, still sync (ff no-op if current)', () => {
    expect(classifyRepo({ defaultBranch: 'main', currentBranch: 'main', dirty: false })).toEqual({
      switchNeeded: false,
      syncAllowed: true,
      dirty: false,
    });
  });
});

describe('reposToMain — fake-git orchestration', () => {
  const present = () => true; // all repos have .git

  it('on default + ff succeeds ⇒ pulled', async () => {
    const git = makeFakeGit({ '/dev/soa': { branch: 'main', def: 'main', ffOk: true } });
    const res = await reposToMain([repo('soa')], { git, pathExists: present });
    expect(res.ok).toBe(true);
    expect(res.repos[0].action).toBe('pulled');
  });

  it('feature branch, clean ⇒ switched+pulled (checkout main happened)', async () => {
    const spy = { checkedOut: [] as string[] };
    const git = makeFakeGit(
      { '/dev/rostering': { branch: 'feat/x', def: 'main', ffOk: true } },
      spy,
    );
    const res = await reposToMain([repo('rostering')], { git, pathExists: present });
    expect(res.repos[0].action).toBe('switched+pulled');
    expect(spy.checkedOut).toContain('/dev/rostering:main');
  });

  it('DIRTY feature branch ⇒ skipped-dirty and NEVER checked out (safety)', async () => {
    const spy = { checkedOut: [] as string[] };
    const git = makeFakeGit(
      { '/dev/qboard': { branch: 'feat/y', def: 'main', porcelain: ' M src/a.ts' } },
      spy,
    );
    const res = await reposToMain([repo('qboard')], { git, pathExists: present });
    expect(res.repos[0].action).toBe('skipped-dirty');
    expect(res.ok).toBe(true); // dirty skip is NOT a failure
    expect(spy.checkedOut).toEqual([]); // never touched the working tree
  });

  it('untracked-only (??) is NOT dirty ⇒ still syncs', async () => {
    const git = makeFakeGit({ '/dev/rtsm': { branch: 'main', porcelain: '?? scratch.txt', ffOk: true } });
    const res = await reposToMain([repo('rtsm')], { git, pathExists: present });
    expect(res.repos[0].action).toBe('pulled');
  });

  it('missing checkout ⇒ skipped-missing (not an error)', async () => {
    const git = makeFakeGit({});
    const res = await reposToMain([repo('program-hub')], { git, pathExists: () => false });
    expect(res.repos[0].action).toBe('skipped-missing');
    expect(res.ok).toBe(true);
  });

  it('checkout failure on a feature branch ⇒ error (ok:false)', async () => {
    const git = makeFakeGit({ '/dev/saga-dash': { branch: 'feat/z', def: 'main', checkoutOk: false } });
    const res = await reposToMain([repo('saga-dash')], { git, pathExists: present });
    expect(res.repos[0].action).toBe('error');
    expect(res.ok).toBe(false);
  });
});
