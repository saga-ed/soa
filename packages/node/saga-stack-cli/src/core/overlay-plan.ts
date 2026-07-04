/**
 * overlay-plan — the PURE planner + accounting for the native git-overlay engine
 * (M10; refresh-suite.sh refresh_repo 125-195 and --reset 376-408).
 *
 * This owns the IO-FREE decisions the orchestrator (`runtime/overlay.ts`) needs:
 *   - `classifyToken` — a numeric token resolves to a PR head ref (via `gh`, IO); a
 *     bare name is a literal branch used verbatim (refresh_repo's `^[0-9]+$` test).
 *   - `splitTokens`   — split a `--prs`/tsv PR set on commas, strip spaces, drop empties
 *     (refresh_repo's `IFS=',' read -ra tokens` + `${tok// /}`).
 *   - `MANAGED_REPOS` — the repos the overlay engine manages by default (reset with no
 *     args resets exactly these); soa + student-data-system are always on main and are
 *     only touched when a user NAMES them (the soa-self-overlay escape).
 *   - the merged/conflicted/missing accounting + the exit-code decision (0 clean / 1 if
 *     any repo hard-skipped or any branch conflicted-or-missing). The orchestrator
 *     gathers the git results into these structured outcomes; THIS decides pass/fail.
 *
 * EXIT CODES ARE LOAD-BEARING (plan hard constraint): refresh-suite.sh returns EXACTLY
 * 0 or 1 for apply/reset (a `&&` chain / CI gate depends on it). `refreshFailed` /
 * `resetFailed` reproduce refresh_repo's `return $rc` and the reset loop's `failed=1`
 * conditions verb-for-verb; `overlayExitCode` / `resetExitCode` fold them with the
 * loop's `failed` semantics (any repo failing ⇒ 1).
 *
 * PURITY: no git, no gh, no fs. `src/core/**` never imports `src/runtime/**`.
 */

/**
 * The repos the overlay engine manages (refresh-suite.sh `MANAGED_REPOS`). `--reset`
 * with no repo args resets exactly this set; soa / student-data-system are NEVER in it
 * (they stay on main unless a user explicitly names them for the soa-self escape).
 */
export const MANAGED_REPOS = ['rostering', 'program-hub', 'saga-dash'] as const;
export type ManagedRepo = (typeof MANAGED_REPOS)[number];

/** A classified overlay token: a numeric PR (needs a `gh` head-ref lookup) or a literal branch. */
export type OverlayToken = { kind: 'pr'; pr: string } | { kind: 'branch'; branch: string };

/**
 * Classify one PR-set token exactly as refresh_repo does: a purely-numeric token is a
 * PR number (resolved to its head ref via `gh`); anything else is a branch name used
 * verbatim (`[[ "$tok" =~ ^[0-9]+$ ]]`).
 */
export function classifyToken(tok: string): OverlayToken {
  return /^[0-9]+$/.test(tok) ? { kind: 'pr', pr: tok } : { kind: 'branch', branch: tok };
}

/**
 * Split a comma-separated PR/branch set into tokens, stripping SPACES and dropping
 * empties — refresh_repo's `IFS=',' read -ra tokens <<<"$prs"` then `tok="${tok// /}";
 * [[ -z "$tok" ]] && continue`. (Only spaces are stripped here, matching `${tok// /}`;
 * the tsv reader already stripped all whitespace from file-sourced sets.)
 */
export function splitTokens(csv: string): string[] {
  return csv
    .split(',')
    .map((t) => t.replace(/ /g, ''))
    .filter((t) => t !== '');
}

// ─────────────────────────────────────────────────────────────────────────────
// apply accounting (refresh_repo)
// ─────────────────────────────────────────────────────────────────────────────

/** The terminal state of one repo's refresh (maps 1:1 to refresh_repo's return paths). */
export type RefreshStatus =
  /** overridden checkout — left as-is, overlay skipped (rc 0). */
  | 'overridden'
  /** `[[ ! -e "$repo/.git" ]]` — not a git repo (rc 1). */
  | 'not-git'
  /** tracked (non-`??`) changes present — refuse (rc 1). */
  | 'dirty'
  /** `git fetch` failed (rc 1). */
  | 'fetch-failed'
  /** `origin/<base>` does not exist (rc 1). */
  | 'base-missing'
  /** no branches to merge after resolution — local/integration == origin/<base> (rc 0). */
  | 'no-prs'
  /** the merge pass ran; see merged/conflicted/missing (rc 1 iff conflicted or missing non-empty). */
  | 'merged';

/** The structured result of refreshing ONE repo — the orchestrator fills this from git. */
export interface RefreshOutcome {
  name: string;
  path: string;
  base: string;
  status: RefreshStatus;
  /** Branches that merged cleanly (`--no-ff`). */
  merged: string[];
  /** Branches whose merge conflicted (aborted via `merge --abort`). */
  conflicted: string[];
  /** Resolved branches absent on origin (`origin/<b>` failed rev-parse). */
  missing: string[];
  /** Numeric PR tokens `gh` couldn't resolve — WARN-ONLY (never a failure), like bash. */
  notFound: string[];
}

/**
 * Did this repo's refresh fail (refresh_repo's non-zero `return`)? A hard pre-merge
 * skip (not-git / dirty / fetch-failed / base-missing) fails; a completed merge pass
 * fails iff any branch conflicted OR was missing on origin. overridden / no-prs /
 * a clean merge succeed. A `notFound` PR is warn-only and NEVER flips this.
 */
export function refreshFailed(o: RefreshOutcome): boolean {
  switch (o.status) {
    case 'not-git':
    case 'dirty':
    case 'fetch-failed':
    case 'base-missing':
      return true;
    case 'merged':
      return o.conflicted.length > 0 || o.missing.length > 0;
    default:
      return false; // overridden, no-prs
  }
}

/** Overall apply exit code: 1 if ANY repo failed, else 0 (the loop's `failed`, `exit $failed`). */
export function overlayExitCode(outcomes: RefreshOutcome[]): number {
  return outcomes.some(refreshFailed) ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// reset accounting (--reset loop)
// ─────────────────────────────────────────────────────────────────────────────

/** The terminal state of one repo's reset (maps 1:1 to the --reset loop's branches). */
export type ResetStatus =
  /** overridden checkout — never overlaid, nothing to reset (rc 0). */
  | 'overridden'
  /** not a git repo at the resolved path — warn+skip (rc 0, does NOT fail, unlike apply). */
  | 'not-git'
  /** not on local/integration (already backed out); a stale local/integration was pruned if present (rc 0). */
  | 'not-overlaid'
  /** on local/integration but has tracked changes — refuse (rc 1). */
  | 'dirty'
  /** on local/integration, clean → checked out base + deleted local/integration (rc 0). */
  | 'reset'
  /** on local/integration, clean, but `git checkout <base>` failed (rc 1). */
  | 'checkout-failed';

/** The structured result of resetting ONE repo. */
export interface ResetOutcome {
  name: string;
  path: string;
  base: string;
  status: ResetStatus;
  /** For `not-overlaid`: the branch the repo is actually on (`''` ⇒ detached, rendered `?`). */
  branch?: string;
  /** For `not-overlaid`: a stale local/integration branch was force-deleted. */
  deletedStale?: boolean;
}

/** Did this repo's reset fail (the loop's `failed=1`)? Only dirty-on-INT or a failed checkout. */
export function resetFailed(o: ResetOutcome): boolean {
  return o.status === 'dirty' || o.status === 'checkout-failed';
}

/** Overall reset exit code: 1 if ANY repo failed, else 0 (`exit $failed`). */
export function resetExitCode(outcomes: ResetOutcome[]): number {
  return outcomes.some(resetFailed) ? 1 : 0;
}
