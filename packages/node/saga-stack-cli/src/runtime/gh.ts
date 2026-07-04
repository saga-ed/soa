/**
 * The `gh` (GitHub CLI) shell-out seam — M10 overlay engine.
 *
 * The overlay engine resolves a numeric PR token to its head branch so it can merge
 * `origin/<headRef>` into `local/integration`. refresh-suite.sh does this with
 * `gh pr view <n> --json headRefName --jq '.headRefName'` run IN THE REPO'S CWD, so
 * `gh` picks up that repo's `origin` remote and resolves the PR against the RIGHT
 * GitHub repo. We keep the same shell-out (parity over an octokit port): it preserves
 * the user's existing `gh` auth and the per-repo repo inference for free.
 *
 * CRITICAL (plan safety): `cwd` MUST be the repo whose PR is being resolved — a wrong
 * cwd resolves the PR number against the wrong repo and merges the wrong branch. The
 * orchestrator always passes the resolved per-repo checkout path.
 *
 * Injectable so the overlay orchestrator is unit-tested with a fake gh — no live
 * network, no `gh` auth, no GitHub. NEVER throws: a missing/unauthenticated `gh`, an
 * unknown PR, or a non-`gh` repo all fold to `''` (⇒ the caller warns "PR not found"
 * and skips it, exactly like bash's `2>/dev/null || true`).
 *
 * INVARIANT: this IO lives only in `src/runtime/**`; `src/core/**` stays pure.
 */

import { execFile } from 'node:child_process';

/** The injectable `gh` seam. One verb: resolve a PR number → its head branch, per repo. */
export interface GhRunner {
  /**
   * `gh pr view <prNumber> --json headRefName --jq '.headRefName'`, run with `cwd` set
   * to the repo's checkout so `gh` resolves the PR against that repo's `origin`.
   * Resolves the trimmed head-ref branch name, or `''` on ANY error/not-found.
   */
  prHeadRef(prNumber: string, cwd: string): Promise<string>;

  // ── M12 source-posture verbs (verify.sh P2/P3) ──
  /**
   * `gh pr view <prNumber> --json headRefOid --jq '.headRefOid'`, run in the repo's cwd.
   * Resolves the PR's head-commit SHA (P2 then asks `merge-base --is-ancestor <oid> HEAD`).
   * `''` on ANY error/not-found ⇒ P2 warns "couldn't resolve head via gh" (never fails).
   */
  prHeadOid(prNumber: string, cwd: string): Promise<string>;
  /**
   * `gh pr list --head <headRef> --state all --json number --jq '.[0].number'`, in cwd.
   * Resolves a branch name back to its PR number (P3 decorates an unpinned overlay with
   * `#<num>`). `''` on ANY error/no-match — the decoration is cosmetic and warn-only.
   */
  prNumberForHead(headRef: string, cwd: string): Promise<string>;
}

/** The production `gh` runner — the ONLY place `gh` is actually spawned. */
export function makeRealGhRunner(): GhRunner {
  return {
    prHeadRef(prNumber: string, cwd: string): Promise<string> {
      return ghOut(['pr', 'view', prNumber, '--json', 'headRefName', '--jq', '.headRefName'], cwd);
    },
    prHeadOid(prNumber: string, cwd: string): Promise<string> {
      return ghOut(['pr', 'view', prNumber, '--json', 'headRefOid', '--jq', '.headRefOid'], cwd);
    },
    prNumberForHead(headRef: string, cwd: string): Promise<string> {
      return ghOut(
        ['pr', 'list', '--head', headRef, '--state', 'all', '--json', 'number', '--jq', '.[0].number'],
        cwd,
      );
    },
  };
}

/** Run `gh …args` in `cwd`; resolve trimmed stdout (`''` on ANY error). NEVER throws. */
function ghOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString().trim());
    });
  });
}
