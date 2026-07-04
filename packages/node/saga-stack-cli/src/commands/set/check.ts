/**
 * `saga-stack set check <name>` — validate a worktree set (M13-A, plan §2.4).
 *
 * Checks, per repo entry:
 *   - the path EXISTS                                → violation when missing;
 *   - buildable vs pre-built (the prep fresh-skip predicate: installed+built
 *     repos are never rebuilt, so sharing them across slots is safe)
 *                                                    → informational;
 *   - the live branch, plus a WARN-only drift report when it no longer matches
 *     the recorded `createdFrom` (worktrees are workspaces; drift never blocks);
 *   - PRIMARY-CHECKOUT posture (tenet 4): a BUILDABLE entry pointing at the
 *     primary `$DEV/<repo>` checkout is a violation (shared repos must be
 *     clean, pre-built worktrees); a pre-built primary entry only warns.
 *
 * Across sets: a cross-set BUILD-COLLISION dry-check — two sets pinning the
 * same realpath where either side would prep-BUILD it is a violation (two
 * slots building one checkout races; plan §4 layer 1's static half — the
 * active-slot up-time guard is M13-B).
 *
 * Exit 1 iff any violation fired (warnings never affect the exit code).
 *
 *   node bin/dev.js set check journey-fix
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { resolveSet } from '../../core/set/index.js';
import type { SetRepoEntry, SetRepoKey, WorktreeSet } from '../../core/set/index.js';
import { REPO_DEFAULT_DIR, REPO_ENV_VAR } from '../../runtime/index.js';
import type { RepoKey as ManifestRepoKey } from '../../core/manifest/index.js';

/** One repo entry's verdicts (also the JSON row). */
interface RepoCheck {
  repo: SetRepoKey;
  path: string;
  exists: boolean;
  prebuilt: boolean | null;
  branch: string | null;
  violations: string[];
  warnings: string[];
}

export default class SetCheck extends BaseCommand {
  static description =
    'Validate a worktree set: paths, buildable-vs-prebuilt, branch drift (warn), primary-checkout posture, cross-set build collisions. Exit 1 on violations.';

  static examples = ['<%= config.bin %> <%= command.id %> journey-fix'];

  static args = {
    name: Args.string({ description: 'set name (see `set list`)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetCheck);
    const file = this.getSetStore().load();
    let set;
    try {
      set = resolveSet(file, args.name);
    } catch (err) {
      return this.error((err as Error).message);
    }

    const git = this.getGitRunner();
    const isPrebuilt = this.getPrepFreshCheck();
    const devRoot = flags.dev ?? join(process.env.HOME ?? '~', 'dev');

    const checks: RepoCheck[] = [];
    for (const [repo, entry] of Object.entries(set.repos) as [SetRepoKey, SetRepoEntry][]) {
      const check: RepoCheck = {
        repo,
        path: entry.path,
        exists: existsSync(entry.path),
        prebuilt: null,
        branch: null,
        violations: [],
        warnings: [],
      };

      if (!check.exists) {
        check.violations.push(`path does not exist: ${entry.path}`);
        checks.push(check);
        continue;
      }

      // A directory that exists but is NOT a git checkout (worktree removed and
      // dir recreated, or a path typo landing on a plain dir) must not render
      // as a healthy clean checkout — prep would build a non-checkout.
      if (!(await git.revParseVerify(entry.path, 'HEAD'))) {
        check.violations.push(
          `exists but is not a git checkout (worktree removed, or a path typo?): ${entry.path}`,
        );
        checks.push(check);
        continue;
      }

      check.prebuilt = isPrebuilt(entry.path);
      check.branch = (await git.branchShowCurrent(entry.path)) || '(detached)';

      // WARN-only drift (skelly's OQ3 call): the set maps PATHS; switching
      // branches inside a worktree is legitimate.
      if (entry.createdFrom !== undefined && check.branch !== entry.createdFrom) {
        check.warnings.push(`branch drift: @ ${check.branch}, created from ${entry.createdFrom}`);
      }

      // Primary-checkout posture (tenet 4).
      const primary = safeRealpath(join(devRoot, REPO_DEFAULT_DIR[repoEnvKey(repo)]));
      if (primary !== null && safeRealpath(entry.path) === primary) {
        if (check.prebuilt) {
          check.warnings.push('points at the primary checkout (pre-built, so running is safe — prefer a worktree)');
        } else {
          check.violations.push(
            'BUILDABLE entry points at the primary checkout — prep would build your live working copy; use a clean worktree',
          );
        }
      }

      checks.push(check);
    }

    // Cross-set build-collision dry-check (static half of plan §4 layer 1) —
    // attributed to the colliding repo's own violation list so every output
    // mode (JSON rows, porcelain rows, human, exit code) reports it uniformly.
    for (const collision of crossSetBuildCollisions(set, file.sets, isPrebuilt)) {
      checks.find((c) => c.repo === collision.repo)?.violations.push(collision.message);
    }

    const violationCount = checks.reduce((n, c) => n + c.violations.length, 0);

    if (flags['output-json']) {
      this.log(JSON.stringify({ name: set.name, slot: set.slot, repos: checks, ok: violationCount === 0 }, null, 2));
      if (violationCount > 0) this.exit(1);
      return;
    }

    if (!flags.porcelain) this.log(`${set.name} — slot ${set.slot}`);
    for (const c of checks) {
      if (flags.porcelain) {
        this.log(`${c.repo}\t${c.violations.length === 0 ? 'ok' : 'violation'}\t${c.warnings.length}`);
        continue;
      }
      if (c.branch === null) {
        this.log(`  ✗ ${c.repo.padEnd(12)} ${c.violations[0]}`);
        continue;
      }
      const posture = c.prebuilt ? 'pre-built' : 'buildable';
      this.log(`  ${c.violations.length ? '✗' : '✓'} ${c.repo.padEnd(12)} ${c.path}  @ ${c.branch} (${posture})`);
      for (const v of c.violations) this.log(`      ✗ ${v}`);
      for (const w of c.warnings) this.log(`      ⚠ ${w}`);
    }
    if (!flags.porcelain) {
      this.log(
        violationCount === 0
          ? `✓ ${set.name}: OK (sets are backend+dash contexts at slot>0 — connect stays on slot 0)`
          : `✗ ${set.name}: ${violationCount} violation(s)`,
      );
    }
    if (violationCount > 0) this.exit(1);
  }
}

/** The env-var key REPO_DEFAULT_DIR is keyed by, from a kebab set key. */
function repoEnvKey(repo: SetRepoKey): ManifestRepoKey {
  return REPO_ENV_VAR[repo] as ManifestRepoKey;
}

/** realpath, or null when the path is missing/unresolvable. */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Two sets pinning one realpath is fine ONLY when the checkout is pre-built
 * (fresh-skip makes prep a no-op); if either side would BUILD it, flag it —
 * attributed to THIS set's repo entry so it lands on that repo's row.
 */
function crossSetBuildCollisions(
  set: WorktreeSet,
  allSets: Record<string, WorktreeSet>,
  isPrebuilt: (repoRoot: string) => boolean,
): { repo: SetRepoKey; message: string }[] {
  const collisions: { repo: SetRepoKey; message: string }[] = [];
  for (const [repo, entry] of Object.entries(set.repos) as [SetRepoKey, SetRepoEntry][]) {
    const real = safeRealpath(entry.path);
    if (real === null) continue;
    for (const other of Object.values(allSets)) {
      if (other.name === set.name) continue;
      for (const [otherRepo, otherEntry] of Object.entries(other.repos) as [SetRepoKey, SetRepoEntry][]) {
        if (safeRealpath(otherEntry.path) === real && !isPrebuilt(entry.path)) {
          collisions.push({
            repo,
            message:
              `build collision: set '${other.name}' ${otherRepo} shares this BUILDABLE checkout (${real}) — ` +
              'pre-build it (fresh-skip) or use distinct worktrees',
          });
        }
      }
    }
  }
  return collisions;
}
