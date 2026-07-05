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

import { execFile, spawn } from 'node:child_process';

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
  /** `git rev-parse HEAD` — the HEAD sha, or `''` when not a checkout / on error (M14 §2.3 advisory). */
  headSha(repoPath: string): Promise<string>;
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

  // ── M12 source-posture verbs (verify.sh P1–P4, ~138-288) ──
  /**
   * `git diff --quiet <refA> <refB>` — true iff the two trees are IDENTICAL (exit 0).
   * verify.sh's `git diff --quiet origin/main HEAD` (P1: an empty local/integration ≡
   * main). A missing ref / any error folds to `false` (⇒ "differs", the safe non-equal
   * answer that only ever downgrades an OK to a WARN — never a failure).
   */
  diffQuiet(repoPath: string, refA: string, refB: string): Promise<boolean>;
  /**
   * `git merge-base --is-ancestor <ancestor> <descendant>` — true iff `<ancestor>` is an
   * ancestor of `<descendant>` (exit 0). verify.sh's P2 `merge-base --is-ancestor <oid>
   * HEAD` (a pinned PR's head SHA is already merged into the checkout). Any error ⇒
   * `false` ("not merged"), which is warn-only in P2 — never a failure.
   */
  mergeBaseIsAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean>;
  /**
   * `git log --merges --pretty=%s <range>` — the raw merge-commit subjects in `<range>`
   * (P3 uses `origin/main..HEAD`). Returns the raw multi-line stdout (`''` on any error);
   * the PURE `extractMergedOverlayBranches` does the sed-equivalent branch extraction.
   */
  logMergeSubjects(repoPath: string, range: string): Promise<string>;
  /**
   * `git rev-list --count HEAD..<ref>` — commits HEAD is BEHIND `<ref>` (P4 freshness,
   * `HEAD..origin/main`). Returns the count, or `null` on any error (verify.sh's `"?"` —
   * "could not compare"). Distinct from `revListCount` (which targets `@{u}` and folds
   * error to 0) because P4 must tell "behind 0" apart from "couldn't compare".
   */
  countBehindRef(repoPath: string, ref: string): Promise<number | null>;

  // ── M11 bootstrap ensure-repos verb ──
  /**
   * `git clone <url> <dir>` — clone a MISSING sibling repo (bootstrap.sh ensure_repos).
   * UNLIKE every verb above this is NOT a `git -C <repo> …` (the repo doesn't exist yet)
   * and runs with stdio INHERITED so an SSH host-key / credential prompt is visible on
   * the user's TTY. Resolves true iff the clone exited 0. NEVER throws (a spawn error /
   * non-zero exit folds to false ⇒ the caller aborts with a clear message).
   */
  clone(url: string, dir: string): Promise<boolean>;
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
    headSha(repoPath: string): Promise<string> {
      return gitOut(repoPath, ['rev-parse', 'HEAD']);
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

    // ── M12 source-posture verbs (verify.sh P1–P4) ──
    diffQuiet(repoPath: string, refA: string, refB: string): Promise<boolean> {
      return gitOk(repoPath, ['diff', '--quiet', refA, refB]);
    },
    mergeBaseIsAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
      return gitOk(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    },
    logMergeSubjects(repoPath: string, range: string): Promise<string> {
      return gitOut(repoPath, ['log', '--merges', '--pretty=%s', range]);
    },
    async countBehindRef(repoPath: string, ref: string): Promise<number | null> {
      // gitOut folds any error to '' — parse that (and any non-numeric) to null so P4
      // can render verify.sh's `?` ("could not compare") distinctly from a real 0.
      const out = await gitOut(repoPath, ['rev-list', '--count', `HEAD..${ref}`]);
      if (out === '') return null;
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : null;
    },

    // ── M11 bootstrap ensure-repos verb ──
    clone(url: string, dir: string): Promise<boolean> {
      // spawn (not execFile) with inherited stdio so a first-time SSH host-key /
      // credential prompt reaches the user's terminal (bootstrap.sh clones interactively).
      return new Promise((resolve) => {
        const child = spawn('git', ['clone', url, dir], { stdio: 'inherit' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
      });
    },
  };
}

/** True iff a porcelain blob has any TRACKED change (a non-`??` line) — up.sh's `grep -v '^??'`. */
export function hasTrackedChanges(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .some((line) => line.trim() !== '' && !line.startsWith('??'));
}
