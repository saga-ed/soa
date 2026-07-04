/**
 * The light, ff-only git runner seam (M9 — auto-pull; up.sh `pull_repos`).
 *
 * A FAITHFUL port of the read-only git probes + the single mutating `merge
 * --ff-only` that up.sh's sibling-sync shells out (`git -C "$dir" …`). Every method
 * is one `execFile('git', […], { cwd: repoPath })` behind this injectable seam, so
 * the auto-pull ORCHESTRATOR (`auto-pull.ts`) and the pure DECISION (`core/auto-pull.ts`)
 * are unit-tested with a fake git — no real repo, network, or working-tree mutation.
 *
 * NEVER throws — every read folds a missing git / non-repo / detached state into the
 * "safe" answer (`''` / `false` / `0`), mirroring up.sh's `2>/dev/null` + empty-string
 * handling. The one mutating call (`mergeFfOnly`) resolves a boolean (exit 0), never
 * throws, so a diverged repo is a clean `false` (⇒ skip), not an abort.
 *
 * SCOPE: this is the M9 ff-only slice ONLY (status/branch/default/fetch/behind/ff).
 * The full git-overlay engine (checkout -B / merge --no-ff / branch -D, M10) is a
 * separate, heavier seam — deliberately NOT bundled here.
 *
 * INVARIANT (plan hard constraint): git IO lives only in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

import { execFile } from 'node:child_process';

/**
 * The injectable ff-only git seam. Read-only probes + one `merge --ff-only`, each a
 * single `git -C <repoPath> …`. Production wires `makeRealGitRunner()`; tests pass a
 * fake that answers from a script.
 */
export interface GitRunner {
  /** `git status --porcelain` — the raw porcelain (`''` on any error). Caller filters `^??`. */
  statusPorcelain(repoPath: string): Promise<string>;
  /** `git branch --show-current` — the current branch, or `''` when detached / on error. */
  branchShowCurrent(repoPath: string): Promise<string>;
  /** origin/HEAD → default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, strip `origin/`); fallback `main`. */
  symbolicRefDefault(repoPath: string): Promise<string>;
  /** `git fetch -q origin` — true iff it exited 0 (network IO; a failure must NOT abort the caller). */
  fetch(repoPath: string): Promise<boolean>;
  /** `git rev-parse --abbrev-ref @{u}` exited 0 — an upstream is configured for HEAD. */
  hasUpstream(repoPath: string): Promise<boolean>;
  /** `git rev-list --count HEAD..@{u}` — commits behind upstream (`0` on any error). */
  revListCount(repoPath: string): Promise<number>;
  /** `git merge --ff-only @{u}` — true iff it exited 0 (false ⇒ diverged / no ff possible). */
  mergeFfOnly(repoPath: string): Promise<boolean>;
}

/** Run `git -C <repoPath> …args`; resolve trimmed stdout (`''` on any error). NEVER throws. */
function gitOut(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, ...args], { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString().trim());
    });
  });
}

/** Run `git -C <repoPath> …args`; resolve true iff it exited 0. NEVER throws. */
function gitOk(repoPath: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, ...args], { encoding: 'utf8' }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * The production ff-only git runner: each method is exactly one `git -C <repo> …`,
 * the same commands up.sh's `pull_repos` runs. Errors fold to the safe answer so a
 * missing/dead repo never throws out of the auto-pull pass.
 */
export function makeRealGitRunner(): GitRunner {
  return {
    statusPorcelain(repoPath: string): Promise<string> {
      return gitOut(repoPath, ['status', '--porcelain']);
    },
    branchShowCurrent(repoPath: string): Promise<string> {
      return gitOut(repoPath, ['branch', '--show-current']);
    },
    async symbolicRefDefault(repoPath: string): Promise<string> {
      const out = await gitOut(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      // Strip a leading `origin/`; fall back to `main` (up.sh's `def=${def:-main}`).
      const def = out.replace(/^origin\//, '');
      return def === '' ? 'main' : def;
    },
    fetch(repoPath: string): Promise<boolean> {
      return gitOk(repoPath, ['fetch', '-q', 'origin']);
    },
    hasUpstream(repoPath: string): Promise<boolean> {
      return gitOk(repoPath, ['rev-parse', '--abbrev-ref', '@{u}']);
    },
    async revListCount(repoPath: string): Promise<number> {
      const out = await gitOut(repoPath, ['rev-list', '--count', 'HEAD..@{u}']);
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : 0;
    },
    mergeFfOnly(repoPath: string): Promise<boolean> {
      return gitOk(repoPath, ['merge', '--ff-only', '@{u}']);
    },
  };
}

/** True iff a porcelain blob has any TRACKED change (a non-`??` line) — up.sh's `grep -v '^??'`. */
export function hasTrackedChanges(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .some((line) => line.trim() !== '' && !line.startsWith('??'));
}
