/**
 * cli-version (soa#341): base from package.json, auto patch from the package's
 * commit count, sha+dirty build metadata, and the git-less fallback.
 */

import { describe, expect, it } from 'vitest';
import { computeCliVersion } from '../cli-version.js';
import type { GitRunner } from '../git.js';

function fakeGit(over: Partial<GitRunner>): GitRunner {
  return {
    commitCount: async () => 218,
    headSha: async () => '65a9c3fdeadbeef0000000000000000000000000',
    statusPorcelain: async () => '',
    ...over,
  } as GitRunner;
}

const BASE = { pkgVersion: '1.0.0', pkgRoot: '/repo/packages/node/saga-stack-cli' };

describe('computeCliVersion', () => {
  it('renders base.patch+shortsha from a clean checkout', async () => {
    const v = await computeCliVersion({ ...BASE, git: fakeGit({}) });
    expect(v).toEqual({
      semver: '1.0.218+65a9c3f',
      base: '1.0',
      patch: 218,
      sha: '65a9c3f',
      dirty: false,
    });
  });

  it('appends .dirty for tracked changes only (untracked files do not count)', async () => {
    const dirty = await computeCliVersion({
      ...BASE,
      git: fakeGit({ statusPorcelain: async () => ' M src/x.ts\n' }),
    });
    expect(dirty.semver).toBe('1.0.218+65a9c3f.dirty');
    const untracked = await computeCliVersion({
      ...BASE,
      git: fakeGit({ statusPorcelain: async () => '?? scratch.md\n' }),
    });
    expect(untracked.semver).toBe('1.0.218+65a9c3f');
  });

  it('major.minor track package.json (a manual 1.1.0 bump flows through)', async () => {
    const v = await computeCliVersion({ ...BASE, pkgVersion: '1.1.0', git: fakeGit({}) });
    expect(v.semver).toBe('1.1.218+65a9c3f');
  });

  it('git-less environment folds to the raw package.json version', async () => {
    const v = await computeCliVersion({
      ...BASE,
      git: fakeGit({ commitCount: async () => null, headSha: async () => '' }),
    });
    expect(v).toEqual({ semver: '1.0.0', base: '1.0', patch: null, sha: '', dirty: false });
  });

  it('count without a sha still renders a bare semver (no dangling +)', async () => {
    const v = await computeCliVersion({ ...BASE, git: fakeGit({ headSha: async () => '' }) });
    expect(v.semver).toBe('1.0.218');
  });
});
