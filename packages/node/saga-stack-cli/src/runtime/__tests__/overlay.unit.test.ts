/**
 * overlay ORCHESTRATOR unit tests (M10; refresh-suite.sh git half).
 *
 * Drive `refreshRepo` / `resetRepo` / `applyOverlay` / `resetOverlay` with a FAKE
 * `GitRunner` + `GhRunner` + `.git` existence predicate — no real git/gh/network/fs.
 * Assert the byte-faithful safety behaviour: overridden repos are skipped untouched,
 * a worktree's `.git`-FILE is accepted while a missing repo is rejected, ONLY tracked
 * changes block, `checkout -B` then per-token verify/merge/merge-abort accounting, a
 * conflicted merge aborts + fails, reset restores base + deletes the branch only when
 * clean, `gh` runs in the correct per-repo cwd, and `local/integration` is NEVER pushed.
 */

import { describe, expect, it } from 'vitest';
import { refreshFailed, resetFailed } from '../../core/overlay-plan.js';
import type { GitRunner, MergeOptions } from '../git.js';
import type { GhRunner } from '../gh.js';
import {
  INTEGRATION_BRANCH,
  applyOverlay,
  refreshRepo,
  resetOverlay,
  resetRepo,
  resolveOverlayRepo,
} from '../overlay.js';

/** Scriptable per-repo git state. */
interface RepoScript {
  porcelain?: string;
  branch?: string;
  /** refs `rev-parse --verify` returns true for. */
  existingRefs?: string[];
  /** `origin/<b>` refs whose merge conflicts (returns false ⇒ abort). */
  mergeConflicts?: string[];
  /** `git checkout <base>` result (reset). Default true. */
  checkoutOk?: boolean;
}

interface FakeGit {
  git: GitRunner;
  calls: string[];
}

function fakeGit(byPath: Record<string, RepoScript> = {}): FakeGit {
  const calls: string[] = [];
  const s = (p: string): RepoScript => byPath[p] ?? {};
  const git: GitRunner = {
    async statusPorcelain(p) {
      calls.push(`status ${p}`);
      return s(p).porcelain ?? '';
    },
    async branchShowCurrent(p) {
      calls.push(`branch ${p}`);
      return s(p).branch ?? 'main';
    },
    async symbolicRefDefault() {
      return 'main';
    },
    async fetch(p) {
      calls.push(`fetch ${p}`);
      return true;
    },
    async hasUpstream() {
      return true;
    },
    async revListCount() {
      return 0;
    },
    async mergeFfOnly() {
      return true;
    },
    async revParseVerify(p, ref) {
      calls.push(`rev-parse ${p} ${ref}`);
      return (s(p).existingRefs ?? []).includes(ref);
    },
    async checkoutB(p, branch, startPoint) {
      calls.push(`checkout-B ${p} ${branch} ${startPoint}`);
      return true;
    },
    async merge(p, ref, opts?: MergeOptions) {
      calls.push(`merge ${p} ${ref} noFf=${!!opts?.noFf} noEdit=${!!opts?.noEdit}`);
      return !(s(p).mergeConflicts ?? []).includes(ref);
    },
    async mergeAbort(p) {
      calls.push(`merge-abort ${p}`);
      return true;
    },
    async branchDelete(p, name) {
      calls.push(`branch-delete ${p} ${name}`);
      return true;
    },
    async checkout(p, ref) {
      calls.push(`checkout ${p} ${ref}`);
      return s(p).checkoutOk ?? true;
    },
  };
  return { git, calls };
}

/** Scriptable gh: PR number → head ref; records the cwd each call ran in. */
function fakeGh(byPr: Record<string, string> = {}): { gh: GhRunner; calls: { pr: string; cwd: string }[] } {
  const calls: { pr: string; cwd: string }[] = [];
  const gh: GhRunner = {
    async prHeadRef(pr, cwd) {
      calls.push({ pr, cwd });
      return byPr[pr] ?? '';
    },
  };
  return { gh, calls };
}

const PATH = '/dev/saga-dash';

describe('refreshRepo — apply engine (refresh_repo 125-195)', () => {
  it('an OVERRIDDEN repo is skipped untouched — no git, no gh', async () => {
    const { git, calls } = fakeGit();
    const { gh, calls: ghCalls } = fakeGh();
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: true, prsCsv: '165', base: 'main' },
      { git, gh, pathExists: () => true },
    );
    expect(o.status).toBe('overridden');
    expect(calls).toEqual([]);
    expect(ghCalls).toEqual([]);
    expect(refreshFailed(o)).toBe(false);
  });

  it('a MISSING repo (.git absent) is rejected (rc 1) before any git', async () => {
    const { git, calls } = fakeGit();
    const { gh } = fakeGh();
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '165', base: 'main' },
      { git, gh, pathExists: () => false },
    );
    expect(o.status).toBe('not-git');
    expect(calls).toEqual([]);
    expect(refreshFailed(o)).toBe(true);
  });

  it("a worktree's `.git` FILE is accepted (predicate is existence, not is-a-dir)", async () => {
    // Production wires `getRepoDirCheck()` = fs.existsSync, which is true for a FILE too
    // (`-e`, not `-d`) — a linked worktree's `.git` is a file. Here the predicate simply
    // returns true, and the engine proceeds past the not-git gate.
    const { git } = fakeGit({ [PATH]: { existingRefs: ['origin/main'] } });
    const { gh } = fakeGh();
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '', base: 'main' },
      { git, gh, pathExists: () => true },
    );
    expect(o.status).toBe('no-prs'); // proceeded past .git check, no PRs to merge
  });

  it('refuses on TRACKED changes; untracked-only (`??`) is clean', async () => {
    const { gh } = fakeGh();
    // tracked change present ⇒ dirty (rc 1), no fetch.
    const dirty = fakeGit({ [PATH]: { porcelain: ' M src/x.ts' } });
    const oDirty = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '165', base: 'main' },
      { git: dirty.git, gh, pathExists: () => true },
    );
    expect(oDirty.status).toBe('dirty');
    expect(dirty.calls).not.toContain(`fetch ${PATH}`);

    // untracked-only ⇒ NOT dirty; proceeds to fetch + checkout -B.
    const clean = fakeGit({ [PATH]: { porcelain: '?? new-file\n?? other', existingRefs: ['origin/main'] } });
    const oClean = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '', base: 'main' },
      { git: clean.git, gh, pathExists: () => true },
    );
    expect(oClean.status).toBe('no-prs');
    expect(clean.calls).toContain(`fetch ${PATH}`);
  });

  it('missing origin/<base> ⇒ base-missing (rc 1), no checkout -B', async () => {
    const { git, calls } = fakeGit({ [PATH]: { existingRefs: [] } }); // origin/main absent
    const { gh } = fakeGh();
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '165', base: 'main' },
      { git, gh, pathExists: () => true },
    );
    expect(o.status).toBe('base-missing');
    expect(refreshFailed(o)).toBe(true);
    expect(calls.some((c) => c.startsWith(`checkout-B ${PATH}`))).toBe(false);
  });

  it('checkout -B origin/<base>, then per-token verify/merge/merge-abort accounting', async () => {
    const { git, calls } = fakeGit({
      [PATH]: {
        existingRefs: ['origin/main', 'origin/feat-a', 'origin/fix/foo'], // origin/gone absent
        mergeConflicts: ['origin/fix/foo'],
      },
    });
    const { gh, calls: ghCalls } = fakeGh({ '165': 'feat-a', '777': '' }); // 777 not found
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '165, fix/foo, gone, 777', base: 'main' },
      { git, gh, pathExists: () => true },
    );

    // checkout -B ran against origin/main.
    expect(calls).toContain(`checkout-B ${PATH} ${INTEGRATION_BRANCH} origin/main`);
    // feat-a merged cleanly; fix/foo conflicted → aborted; gone missing on origin; 777 not found by gh.
    expect(o.merged).toEqual(['feat-a']);
    expect(o.conflicted).toEqual(['fix/foo']);
    expect(o.missing).toEqual(['gone']);
    expect(o.notFound).toEqual(['777']);
    // the conflict was aborted.
    expect(calls).toContain(`merge-abort ${PATH}`);
    // gh resolved 165 (and 777) in the REPO's cwd.
    expect(ghCalls).toEqual([
      { pr: '165', cwd: PATH },
      { pr: '777', cwd: PATH },
    ]);
    // no-ff --no-edit merges only.
    expect(calls).toContain(`merge ${PATH} origin/feat-a noFf=true noEdit=true`);
    // conflicted or missing ⇒ exit 1.
    expect(refreshFailed(o)).toBe(true);
  });

  it('a clean single-PR overlay merges and does NOT fail', async () => {
    const { git } = fakeGit({ [PATH]: { existingRefs: ['origin/main', 'origin/feat-a'] } });
    const { gh } = fakeGh({ '165': 'feat-a' });
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '165', base: 'main' },
      { git, gh, pathExists: () => true },
    );
    expect(o.status).toBe('merged');
    expect(o.merged).toEqual(['feat-a']);
    expect(refreshFailed(o)).toBe(false);
  });

  it('NEVER pushes local/integration (the seam has no push verb; no push-like call recorded)', async () => {
    const { git, calls } = fakeGit({ [PATH]: { existingRefs: ['origin/main', 'origin/feat-a'] } });
    const { gh } = fakeGh({ '165': 'feat-a' });
    await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '165', base: 'main' },
      { git, gh, pathExists: () => true },
    );
    expect(calls.some((c) => /push|upstream|set-upstream|--set-upstream/.test(c))).toBe(false);
  });

  it('honours a non-main base (BASE override)', async () => {
    const { git, calls } = fakeGit({ [PATH]: { existingRefs: ['origin/develop'] } });
    const { gh } = fakeGh();
    const o = await refreshRepo(
      { name: 'saga-dash', path: PATH, overridden: false, prsCsv: '', base: 'develop' },
      { git, gh, pathExists: () => true },
    );
    expect(o.status).toBe('no-prs');
    expect(calls).toContain(`rev-parse ${PATH} origin/develop`);
    expect(calls).toContain(`checkout-B ${PATH} ${INTEGRATION_BRANCH} origin/develop`);
  });
});

describe('applyOverlay — the per-repo loop', () => {
  it('runs each target in order and collects outcomes', async () => {
    const { git } = fakeGit({
      '/dev/rostering': { existingRefs: ['origin/main'] },
      '/dev/saga-dash': { existingRefs: ['origin/main', 'origin/feat-a'] },
    });
    const { gh } = fakeGh({ '165': 'feat-a' });
    const outcomes = await applyOverlay(
      [
        { name: 'rostering', path: '/dev/rostering', overridden: false, prsCsv: '', base: 'main' },
        { name: 'saga-dash', path: '/dev/saga-dash', overridden: false, prsCsv: '165', base: 'main' },
      ],
      { git, gh, pathExists: () => true },
    );
    expect(outcomes.map((o) => o.name)).toEqual(['rostering', 'saga-dash']);
    expect(outcomes[0].status).toBe('no-prs');
    expect(outcomes[1].merged).toEqual(['feat-a']);
  });
});

describe('resetRepo — backout engine (--reset 376-408)', () => {
  it('an OVERRIDDEN repo is skipped (rc 0), untouched', async () => {
    const { git, calls } = fakeGit();
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: true, base: 'main' },
      { git, pathExists: () => true },
    );
    expect(o.status).toBe('overridden');
    expect(calls).toEqual([]);
    expect(resetFailed(o)).toBe(false);
  });

  it('a missing repo warns+skips WITHOUT failing (rc 0, unlike apply)', async () => {
    const { git } = fakeGit();
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: false, base: 'main' },
      { git, pathExists: () => false },
    );
    expect(o.status).toBe('not-git');
    expect(resetFailed(o)).toBe(false);
  });

  it('not on local/integration → not-overlaid; prunes a stale local/integration if present', async () => {
    const { git, calls } = fakeGit({ [PATH]: { branch: 'main', existingRefs: [INTEGRATION_BRANCH] } });
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: false, base: 'main' },
      { git, pathExists: () => true },
    );
    expect(o.status).toBe('not-overlaid');
    expect(o.branch).toBe('main');
    expect(o.deletedStale).toBe(true);
    expect(calls).toContain(`branch-delete ${PATH} ${INTEGRATION_BRANCH}`);
    // never checked out base — it wasn't overlaid.
    expect(calls).not.toContain(`checkout ${PATH} main`);
  });

  it('not on local/integration, no stale branch → not-overlaid, deletes nothing', async () => {
    const { git, calls } = fakeGit({ [PATH]: { branch: 'main', existingRefs: [] } });
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: false, base: 'main' },
      { git, pathExists: () => true },
    );
    expect(o.status).toBe('not-overlaid');
    expect(o.deletedStale).toBeFalsy();
    expect(calls.some((c) => c.startsWith(`branch-delete`))).toBe(false);
  });

  it('on local/integration + tracked changes → dirty (rc 1), does NOT checkout base', async () => {
    const { git, calls } = fakeGit({ [PATH]: { branch: INTEGRATION_BRANCH, porcelain: ' M f' } });
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: false, base: 'main' },
      { git, pathExists: () => true },
    );
    expect(o.status).toBe('dirty');
    expect(resetFailed(o)).toBe(true);
    expect(calls).not.toContain(`checkout ${PATH} main`);
  });

  it('on local/integration + clean → checkout base + delete branch (rc 0)', async () => {
    const { git, calls } = fakeGit({ [PATH]: { branch: INTEGRATION_BRANCH, porcelain: '?? scratch' } });
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: false, base: 'main' },
      { git, pathExists: () => true },
    );
    expect(o.status).toBe('reset');
    expect(calls).toContain(`checkout ${PATH} main`);
    expect(calls).toContain(`branch-delete ${PATH} ${INTEGRATION_BRANCH}`);
    expect(resetFailed(o)).toBe(false);
  });

  it('on local/integration, clean, but checkout FAILS → checkout-failed (rc 1), branch NOT deleted', async () => {
    const { git, calls } = fakeGit({ [PATH]: { branch: INTEGRATION_BRANCH, checkoutOk: false } });
    const o = await resetRepo(
      { name: 'saga-dash', path: PATH, overridden: false, base: 'main' },
      { git, pathExists: () => true },
    );
    expect(o.status).toBe('checkout-failed');
    expect(resetFailed(o)).toBe(true);
    expect(calls).not.toContain(`branch-delete ${PATH} ${INTEGRATION_BRANCH}`);
  });

  it('resetOverlay defaults are driven per repo in order', async () => {
    const { git } = fakeGit({
      '/dev/rostering': { branch: 'main', existingRefs: [] },
      '/dev/saga-dash': { branch: INTEGRATION_BRANCH, porcelain: '' },
    });
    const outcomes = await resetOverlay(
      [
        { name: 'rostering', path: '/dev/rostering', overridden: false, base: 'main' },
        { name: 'saga-dash', path: '/dev/saga-dash', overridden: false, base: 'main' },
      ],
      { git, pathExists: () => true },
    );
    expect(outcomes.map((o) => o.status)).toEqual(['not-overlaid', 'reset']);
  });
});

describe('resolveOverlayRepo — repo_path() / repo_overridden() parity', () => {
  it('a default checkout is NOT overridden; the path is <dev>/<name>', () => {
    const r = resolveOverlayRepo('saga-dash', { dev: '/w' });
    expect(r).toEqual({ path: '/w/saga-dash', overridden: false });
  });

  it('student-data-system maps to the SDS default dir', () => {
    const r = resolveOverlayRepo('student-data-system', { dev: '/w' });
    expect(r).toEqual({ path: '/w/student-data-system', overridden: false });
  });

  it('a pinned repo path is flagged OVERRIDDEN (⇒ overlay skips it)', () => {
    const r = resolveOverlayRepo('rostering', { dev: '/w', repoRoots: { ROSTERING: '/elsewhere/rostering' } });
    expect(r).toEqual({ path: '/elsewhere/rostering', overridden: true });
  });

  it('an unmapped repo name → <dev>/<name>, never overridden (the `*)` fallthrough)', () => {
    const r = resolveOverlayRepo('some-other-repo', { dev: '/w' });
    expect(r).toEqual({ path: '/w/some-other-repo', overridden: false });
  });
});
