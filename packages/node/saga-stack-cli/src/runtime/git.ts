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
 * SCOPE: this is the M9 ff-only slice PLUS the M10 git-overlay verbs
 * (`revParseVerify` / `checkoutB` / `merge` / `mergeAbort` / `branchDelete` /
 * `checkout`) the overlay engine (`runtime/overlay.ts`) drives. All share the same
 * `execFile('git', ['-C', repoPath, …])` per-repo-cwd pattern; the overlay verbs are
 * added to this ONE seam (not duplicated) so a single fake covers auto-pull + overlay.
 *
 * INVARIANT (plan hard constraint): git IO lives only in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

import { execFile } from 'node:child_process';

/** Options for `merge` — the overlay engine's `merge --no-ff --no-edit <ref>`. */
export interface MergeOptions {
  /** `--no-ff`: force a merge commit even when a fast-forward is possible (overlay uses this). */
  noFf?: boolean;
  /** `--no-edit`: accept the default merge message without opening an editor. */
  noEdit?: boolean;
}

/**
 * The injectable git seam. Read-only probes + the ff-only merge (M9) + the
 * overlay-engine mutations (M10), each a single `git -C <repoPath> …`. Production
 * wires `makeRealGitRunner()`; tests pass a fake that answers from a script.
 *
 * SAFETY (M10): there is NO push/upstream-tracking verb here BY DESIGN —
 * `local/integration` is local-only and must never be pushed. The overlay engine
 * structurally cannot push because this seam offers no way to.
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

  // ── M10 overlay-engine verbs (refresh-suite.sh refresh_repo / reset) ──
  /** `git rev-parse --verify --quiet <ref>` exited 0 — the ref exists (origin/<base>, origin/<b>, or local/integration). */
  revParseVerify(repoPath: string, ref: string): Promise<boolean>;
  /** `git checkout -B <branch> <startPoint>` — (re)create+switch to a branch at a start point (untracked files survive). */
  checkoutB(repoPath: string, branch: string, startPoint: string): Promise<boolean>;
  /** `git merge [--no-ff] [--no-edit] <ref>` — true iff it exited 0 (false ⇒ conflict, caller aborts). */
  merge(repoPath: string, ref: string, opts?: MergeOptions): Promise<boolean>;
  /** `git merge --abort` — undo a conflicted in-progress merge (best-effort; bash `|| true`). */
  mergeAbort(repoPath: string): Promise<boolean>;
  /** `git branch -D <name>` — force-delete a local branch (the disposable local/integration). */
  branchDelete(repoPath: string, name: string): Promise<boolean>;
  /** `git checkout <ref>` — switch to an existing ref (reset restores the base branch). */
  checkout(repoPath: string, ref: string): Promise<boolean>;
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

    // ── M10 overlay-engine verbs ──
    revParseVerify(repoPath: string, ref: string): Promise<boolean> {
      return gitOk(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    },
    checkoutB(repoPath: string, branch: string, startPoint: string): Promise<boolean> {
      return gitOk(repoPath, ['checkout', '-B', branch, startPoint]);
    },
    merge(repoPath: string, ref: string, opts: MergeOptions = {}): Promise<boolean> {
      const args = ['merge'];
      if (opts.noFf) args.push('--no-ff');
      if (opts.noEdit) args.push('--no-edit');
      args.push(ref);
      return gitOk(repoPath, args);
    },
    mergeAbort(repoPath: string): Promise<boolean> {
      return gitOk(repoPath, ['merge', '--abort']);
    },
    branchDelete(repoPath: string, name: string): Promise<boolean> {
      return gitOk(repoPath, ['branch', '-D', name]);
    },
    checkout(repoPath: string, ref: string): Promise<boolean> {
      return gitOk(repoPath, ['checkout', ref]);
    },
  };
}

/** True iff a porcelain blob has any TRACKED change (a non-`??` line) — up.sh's `grep -v '^??'`. */
export function hasTrackedChanges(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .some((line) => line.trim() !== '' && !line.startsWith('??'));
}
