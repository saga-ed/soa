/**
 * Pure auto-pull DECISION unit tests (M9; up.sh `pull_repos` skip/ff states).
 *
 * Assert `classifyPreFetch` / `classifyPostFetch` reproduce EVERY up.sh skip state
 * (not-cloned, dirty-tracked, detached, off-default-branch, fetch-failed, no-upstream,
 * up-to-date, behind→ff) with NO IO — the load-bearing default-branch gate included.
 */

import { describe, expect, it } from 'vitest';
import { classifyPostFetch, classifyPreFetch } from '../auto-pull.js';
import type { PreFetchObs } from '../auto-pull.js';

const base: PreFetchObs = {
  name: 'program-hub',
  cloned: true,
  dirty: false,
  branch: 'main',
  mode: 'auto',
  defaultBranch: 'main',
};

describe('classifyPreFetch — the pre-network skip gates', () => {
  it('not cloned ⇒ skip', () => {
    const d = classifyPreFetch({ ...base, cloned: false });
    expect(d).toMatchObject({ kind: 'skip', reason: 'not-cloned' });
    expect(d.kind === 'skip' && d.message).toContain('not cloned');
  });

  it('tracked changes ⇒ skip (dirty)', () => {
    const d = classifyPreFetch({ ...base, dirty: true });
    expect(d).toMatchObject({ kind: 'skip', reason: 'dirty' });
  });

  it('detached HEAD (empty branch) ⇒ skip', () => {
    const d = classifyPreFetch({ ...base, branch: '' });
    expect(d).toMatchObject({ kind: 'skip', reason: 'detached' });
  });

  it('auto mode, off the default branch ⇒ LEAVE as-is (overlay/feature branch, not a skip)', () => {
    const d = classifyPreFetch({ ...base, branch: 'local/integration', defaultBranch: 'main' });
    expect(d.kind).toBe('leave');
    expect(d.kind === 'leave' && d.message).toContain('local/integration');
    expect(d.kind === 'leave' && d.message).toContain('not main');
  });

  it('LOAD-BEARING: default-branch detection gates the ff — a repo on `main` matching origin/HEAD proceeds', () => {
    expect(classifyPreFetch({ ...base, branch: 'main', defaultBranch: 'main' })).toEqual({ kind: 'proceed' });
    // If origin/HEAD resolves to `master`, a `main` checkout is treated as off-default (left as-is).
    expect(classifyPreFetch({ ...base, branch: 'main', defaultBranch: 'master' }).kind).toBe('leave');
  });

  it('ALL mode syncs any branch (default-branch gate does NOT apply)', () => {
    const d = classifyPreFetch({ ...base, mode: 'all', branch: 'local/integration', defaultBranch: 'main' });
    expect(d).toEqual({ kind: 'proceed' });
  });

  it('order: dirty is checked before the branch gate (a dirty overlay is `dirty`, not `leave`)', () => {
    const d = classifyPreFetch({ ...base, dirty: true, branch: 'feature/x', defaultBranch: 'main' });
    expect(d).toMatchObject({ kind: 'skip', reason: 'dirty' });
  });
});

describe('classifyPostFetch — the post-fetch outcomes', () => {
  const p = { name: 'program-hub', branch: 'main' };

  it('fetch failed ⇒ skip (network IO, non-fatal)', () => {
    const d = classifyPostFetch({ ...p, fetchOk: false, hasUpstream: false, behind: 0 });
    expect(d).toMatchObject({ kind: 'skip', reason: 'fetch-failed' });
  });

  it('no upstream ⇒ skip', () => {
    const d = classifyPostFetch({ ...p, fetchOk: true, hasUpstream: false, behind: 0 });
    expect(d).toMatchObject({ kind: 'skip', reason: 'no-upstream' });
  });

  it('behind 0 ⇒ up to date (no ff)', () => {
    const d = classifyPostFetch({ ...p, fetchOk: true, hasUpstream: true, behind: 0 });
    expect(d.kind).toBe('up-to-date');
  });

  it('behind N ⇒ ff intent carrying the count', () => {
    const d = classifyPostFetch({ ...p, fetchOk: true, hasUpstream: true, behind: 3 });
    expect(d).toEqual({ kind: 'ff', behind: 3 });
  });
});
