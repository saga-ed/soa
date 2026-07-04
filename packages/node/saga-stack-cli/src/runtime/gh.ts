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
}

/** The production `gh` runner — the ONLY place `gh` is actually spawned. */
export function makeRealGhRunner(): GhRunner {
  return {
    prHeadRef(prNumber: string, cwd: string): Promise<string> {
      return new Promise((resolve) => {
        execFile(
          'gh',
          ['pr', 'view', prNumber, '--json', 'headRefName', '--jq', '.headRefName'],
          { cwd, encoding: 'utf8' },
          (err, stdout) => {
            resolve(err ? '' : (stdout ?? '').toString().trim());
          },
        );
      });
    },
  };
}
