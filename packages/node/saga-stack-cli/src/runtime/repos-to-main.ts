/**
 * `reposToMain` — put every required sibling repo on its DEFAULT branch, current with origin,
 * for a cold start (soa#cold-start). Distinct from BOTH neighbours:
 *   - `ensure-repos` only CLONES the missing ones (a present repo is untouched).
 *   - `auto-pull` (up.sh `pull_repos`) only ff's a repo ALREADY ON its default branch — a
 *     feature/overlay branch is left as-is (by design, so `up` respects an in-flight branch).
 * A cold start is the opposite intent: leave NO feature branch behind — actively SWITCH each
 * repo back to `main` (its `origin/HEAD` default) and fast-forward it to origin.
 *
 * SAFETY — never discard the user's work. A repo with TRACKED, uncommitted changes (a non-`??`
 * porcelain line) is NOT switched or reset; it is reported `skipped-dirty` and left exactly as
 * is, so a cold start can never nuke in-progress edits. (`--force` at the command layer is a
 * possible future opt-in; the default is strictly non-destructive.) The one mutation on a clean
 * repo is `checkout <default>` + `merge --ff-only @{u}` — both reuse the EXISTING `GitRunner`
 * seam (no new git verbs), so a diverged/blocked repo folds to a warn, never an abort.
 *
 * The decision (`classifyRepo`) is PURE and unit-tested; the orchestrator (`reposToMain`) applies
 * it through the injectable git seam. IO stays in `src/runtime/**`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasTrackedChanges } from './git.js';
import type { GitRunner } from './git.js';
import type { EnsureRepo } from './ensure-repos.js';

/** What a cold-start sync did (or didn't do) to one repo. */
export type RepoSyncAction =
  | 'up-to-date' // already on default, nothing behind
  | 'switched' // moved onto default (was on a feature branch), clean/nothing to pull
  | 'pulled' // was on default, fast-forwarded to origin
  | 'switched+pulled' // moved onto default AND fast-forwarded
  | 'skipped-dirty' // tracked local changes — left untouched (safety)
  | 'skipped-missing' // no `.git` — not cloned yet (ensure-repos owns that)
  | 'error'; // a git verb failed (checkout/merge) — surfaced, not fatal

/** The PURE per-repo plan derived from its observed git state. */
export interface RepoPlan {
  /** Switch onto the default branch first? (⇔ not already on it). */
  switchNeeded: boolean;
  /** Attempt a `merge --ff-only @{u}` after any switch? (false only when dirty). */
  syncAllowed: boolean;
  /** Set when the repo is dirty — the plan is a no-op skip. */
  dirty: boolean;
}

/**
 * PURE decision: given a repo's default branch, current branch, and dirtiness, decide the plan.
 * Dirty ⇒ do nothing (protect the work). Otherwise switch iff off-default, and always allow the
 * ff-sync (a no-op when already current).
 */
export function classifyRepo(input: {
  defaultBranch: string;
  currentBranch: string;
  dirty: boolean;
}): RepoPlan {
  if (input.dirty) return { switchNeeded: false, syncAllowed: false, dirty: true };
  const switchNeeded = input.currentBranch !== input.defaultBranch;
  return { switchNeeded, syncAllowed: true, dirty: false };
}

/** One repo's sync outcome (for the command's report + JSON). */
export interface RepoSyncResult {
  /** The repo dir name (e.g. `student-data-system`). */
  name: string;
  action: RepoSyncAction;
  /** The branch the repo was on before (empty when detached / missing). */
  fromBranch: string;
  /** The default branch it was moved to (its `origin/HEAD`). */
  defaultBranch: string;
  /** A ready-to-print, human line. */
  message: string;
}

/** The seams `reposToMain` drives. */
export interface ReposToMainDeps {
  git: GitRunner;
  /** `.git` presence predicate — default `fs.existsSync` (a worktree's `.git` is a FILE). */
  pathExists?: (p: string) => boolean;
  /** Optional human-line sink (the command injects `this.log`). */
  notify?: (msg: string) => void;
}

/** The outcome of a whole cold-start repo sync. */
export interface ReposToMainResult {
  /** True iff no repo ended in `error` (dirty/missing skips are NOT failures). */
  ok: boolean;
  repos: RepoSyncResult[];
}

/**
 * Put each required repo on its default branch + fast-forward it to origin, skipping any repo
 * with uncommitted tracked changes. Never throws — every giving-up path is a structured
 * `RepoSyncResult`, so the command renders the whole table and decides the exit policy.
 */
export async function reposToMain(
  repos: EnsureRepo[],
  deps: ReposToMainDeps,
): Promise<ReposToMainResult> {
  const exists = deps.pathExists ?? ((p: string) => existsSync(p));
  const notify = deps.notify ?? ((): void => {});
  const { git } = deps;

  const results: RepoSyncResult[] = [];
  for (const repo of repos) {
    const res = await syncOne(repo, git, exists);
    results.push(res);
    notify(`  ${symbol(res.action)} ${repo.name.padEnd(20)} ${res.message}`);
  }
  return { ok: results.every((r) => r.action !== 'error'), repos: results };
}

/** Sync one repo (see the module header for the safety rules). */
async function syncOne(
  repo: EnsureRepo,
  git: GitRunner,
  exists: (p: string) => boolean,
): Promise<RepoSyncResult> {
  if (!exists(join(repo.path, '.git'))) {
    return {
      name: repo.name,
      action: 'skipped-missing',
      fromBranch: '',
      defaultBranch: '',
      message: 'not cloned — run with --yes (or `ss stack bootstrap`) to clone it',
    };
  }

  // Fetch first so the default branch + upstream comparisons see origin's latest (best-effort;
  // a fetch failure just means we ff to whatever's already fetched).
  await git.fetch(repo.path);

  const defaultBranch = await git.symbolicRefDefault(repo.path);
  const currentBranch = await git.branchShowCurrent(repo.path);
  const dirty = hasTrackedChanges(await git.statusPorcelain(repo.path));

  const plan = classifyRepo({ defaultBranch, currentBranch, dirty });

  if (plan.dirty) {
    return {
      name: repo.name,
      action: 'skipped-dirty',
      fromBranch: currentBranch || '(detached)',
      defaultBranch,
      message: `uncommitted changes on ${currentBranch || '(detached)'} — LEFT AS-IS (commit/stash, then re-run)`,
    };
  }

  let switched = false;
  if (plan.switchNeeded) {
    const ok = await git.checkout(repo.path, defaultBranch);
    if (!ok) {
      return {
        name: repo.name,
        action: 'error',
        fromBranch: currentBranch || '(detached)',
        defaultBranch,
        message: `could not checkout ${defaultBranch} (from ${currentBranch || '(detached)'}) — resolve by hand`,
      };
    }
    switched = true;
  }

  // ff-sync to origin (@{u} is origin/<default> now we're on it). A non-ff (shouldn't happen on
  // a fresh checkout of default) folds to a warn rather than a reset — we never force.
  const pulled = await git.mergeFfOnly(repo.path);

  if (switched && pulled) {
    return {
      name: repo.name,
      action: 'switched+pulled',
      fromBranch: currentBranch,
      defaultBranch,
      message: `${currentBranch} → ${defaultBranch}, fast-forwarded to origin`,
    };
  }
  if (switched) {
    return {
      name: repo.name,
      action: 'switched',
      fromBranch: currentBranch,
      defaultBranch,
      message: `${currentBranch} → ${defaultBranch} (already current, or no upstream)`,
    };
  }
  if (pulled) {
    return {
      name: repo.name,
      action: 'pulled',
      fromBranch: currentBranch,
      defaultBranch,
      message: `on ${defaultBranch}, fast-forwarded to origin`,
    };
  }
  return {
    name: repo.name,
    action: 'up-to-date',
    fromBranch: currentBranch,
    defaultBranch,
    message: `on ${defaultBranch}, current`,
  };
}

/** The status glyph for a sync action (matches the ✓/·/⚠/✗ vocabulary used elsewhere). */
function symbol(action: RepoSyncAction): string {
  switch (action) {
    case 'up-to-date':
      return '·';
    case 'switched':
    case 'pulled':
    case 'switched+pulled':
      return '✓';
    case 'skipped-dirty':
    case 'skipped-missing':
      return '⚠';
    case 'error':
      return '✗';
  }
}
