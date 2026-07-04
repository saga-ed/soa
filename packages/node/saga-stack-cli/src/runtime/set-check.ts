/**
 * Shared worktree-set checker (M13-A `set check` + M13-B up-time preflight,
 * plan §2.4/§4). One evaluation, two consumers:
 *
 *   - the `ss set check` command renders every repo's verdicts;
 *   - `stack up --set` / `e2e run --set` run it IMPLICITLY and hard-error on
 *     violations (M13-B layer 1), with `--allow-primary` downgrading the
 *     primary-checkout violation to a warning.
 *
 * Verdicts per repo entry: existence, git-checkout-ness (`rev-parse HEAD` —
 * `branch --show-current` alone folds errors to '', indistinguishable from a
 * real detached HEAD), buildable-vs-prebuilt (the prep fresh-skip predicate),
 * WARN-only branch drift vs `createdFrom`, primary-checkout posture (tenet 4),
 * and the cross-set build-collision dry-check. The M13-B ACTIVE-slot collision
 * adds: a repo THIS run would build must not be in use by a set whose slot is
 * live right now (two slots building/running one checkout races).
 *
 * Pure given its seams (git runner, fresh predicate, activity probe) — no
 * direct process/docker IO here beyond fs realpath/exists.
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SetRepoEntry, SetRepoKey, WorktreeSet } from '../core/set/index.js';
import { deriveInstance } from '../core/derive-instance.js';
import type { GitRunner } from './git.js';
import { REPO_DEFAULT_DIR } from './scripts.js';
import { REPO_ENV_VAR } from './repos.js';
import type { RepoKey as ManifestRepoKey } from '../core/manifest/index.js';
import type { SlotActiveProbe } from './slot-active.js';

/** One repo entry's verdicts (also the `set check` JSON row). */
export interface SetRepoCheck {
  repo: SetRepoKey;
  path: string;
  exists: boolean;
  /** False when the dir exists but is not a git checkout (null before probing). */
  checkout: boolean;
  prebuilt: boolean | null;
  branch: string | null;
  violations: string[];
  warnings: string[];
}

export interface SetCheckDeps {
  git: GitRunner;
  /** The prep fresh-skip predicate: installed + built ⇒ prep is a no-op. */
  isPrebuilt: (repoRoot: string) => boolean;
  /** `--dev` workspace root (primary checkouts live at `<devRoot>/<repo-dir>`). */
  devRoot: string;
  /**
   * M13-B: live slot-activity probe. Absent ⇒ the ACTIVE-slot collision leg is
   * skipped (the static cross-set dry-check still runs) — `set check` passes it,
   * the up-time preflight always does.
   */
  activeProbe?: SlotActiveProbe;
  /** Downgrade the buildable-at-primary violation to a warning (`--allow-primary`). */
  allowPrimary?: boolean;
}

export interface SetCheckResult {
  repos: SetRepoCheck[];
  violationCount: number;
}

/** realpath, or null when the path is missing/unresolvable. */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The env-var key `REPO_DEFAULT_DIR` is keyed by, from a kebab set key. */
function repoEnvKey(repo: SetRepoKey): ManifestRepoKey {
  return REPO_ENV_VAR[repo] as ManifestRepoKey;
}

/** Evaluate one set against the store + live slots. */
export async function checkWorktreeSet(
  set: WorktreeSet,
  allSets: Record<string, WorktreeSet>,
  deps: SetCheckDeps,
): Promise<SetCheckResult> {
  const checks: SetRepoCheck[] = [];

  for (const [repo, entry] of Object.entries(set.repos) as [SetRepoKey, SetRepoEntry][]) {
    const check: SetRepoCheck = {
      repo,
      path: entry.path,
      exists: existsSync(entry.path),
      checkout: false,
      prebuilt: null,
      branch: null,
      violations: [],
      warnings: [],
    };
    checks.push(check);

    if (!check.exists) {
      check.violations.push(`path does not exist: ${entry.path}`);
      continue;
    }

    // A directory that exists but is NOT a git checkout (worktree removed and
    // dir recreated, or a path typo landing on a plain dir) must not render
    // as a healthy clean checkout — prep would build a non-checkout.
    if (!(await deps.git.revParseVerify(entry.path, 'HEAD'))) {
      check.violations.push(
        `exists but is not a git checkout (worktree removed, or a path typo?): ${entry.path}`,
      );
      continue;
    }
    check.checkout = true;

    check.prebuilt = deps.isPrebuilt(entry.path);
    check.branch = (await deps.git.branchShowCurrent(entry.path)) || '(detached)';

    // WARN-only drift (skelly's OQ3 call): the set maps PATHS; switching
    // branches inside a worktree is legitimate.
    if (entry.createdFrom !== undefined && check.branch !== entry.createdFrom) {
      check.warnings.push(`branch drift: @ ${check.branch}, created from ${entry.createdFrom}`);
    }

    // Primary-checkout posture (tenet 4): shared repos must be clean,
    // pre-built, effectively read-only worktrees — never the hot primary.
    const primary = safeRealpath(join(deps.devRoot, REPO_DEFAULT_DIR[repoEnvKey(repo)]));
    if (primary !== null && safeRealpath(entry.path) === primary) {
      if (check.prebuilt) {
        check.warnings.push('points at the primary checkout (pre-built, so running is safe — prefer a worktree)');
      } else if (deps.allowPrimary) {
        check.warnings.push('BUILDABLE entry at the primary checkout — allowed by --allow-primary (risky)');
      } else {
        check.violations.push(
          'BUILDABLE entry points at the primary checkout — prep would build your live working copy; ' +
            'use a clean worktree (or pass --allow-primary)',
        );
      }
    }
  }

  // Cross-set build-collision dry-check (plan §4 layer 1, static half) —
  // attributed to the colliding repo's own row so every output mode agrees.
  for (const check of checks) {
    if (!check.exists) continue;
    const real = safeRealpath(check.path);
    if (real === null) continue;
    for (const other of Object.values(allSets)) {
      if (other.name === set.name) continue;
      for (const [otherRepo, otherEntry] of Object.entries(other.repos) as [SetRepoKey, SetRepoEntry][]) {
        if (safeRealpath(otherEntry.path) !== real || deps.isPrebuilt(check.path)) continue;
        check.violations.push(
          `build collision: set '${other.name}' ${otherRepo} shares this BUILDABLE checkout (${real}) — ` +
            'pre-build it (fresh-skip) or use distinct worktrees',
        );
        // M13-B live half: if that other set's slot is ACTIVE right now, say so —
        // the static line already made it a violation; this sharpens the message.
        if (deps.activeProbe !== undefined) {
          const profile = deriveInstance({ slot: other.slot });
          if (await deps.activeProbe.isActive(profile.stateDir, profile.project)) {
            check.violations.push(
              `…and set '${other.name}' (slot ${other.slot}) is ACTIVE right now — building would race its running services`,
            );
          }
        }
      }
    }
  }

  return { repos: checks, violationCount: checks.reduce((n, c) => n + c.violations.length, 0) };
}
