/**
 * `ss version` — the CLI's auto-incrementing semantic version (soa#341).
 *
 * The CLI is repo-resident (always run out of a soa checkout), so the version
 * is DERIVED AT RUNTIME from git instead of maintained by hand or stamped by
 * CI: major.minor come from package.json (bumped deliberately on breaking /
 * feature-line changes), while the PATCH is the commit count of the CLI
 * package directory at HEAD — monotonic on main, no release process, no bump
 * commits. Build metadata (semver `+…`, ignored by precedence) carries the
 * short HEAD sha plus a `.dirty` marker when the checkout has uncommitted
 * tracked changes — an honest "this binary may not match any commit".
 *
 * Every git probe folds to the package.json version on failure (tarball
 * install, deleted .git, detached environments): `ss version` never throws.
 * Seam style mirrors slot-active.ts — deps injectable, real defaults inside.
 */

import { hasTrackedChanges } from './git.js';
import type { GitRunner } from './git.js';

/** What `ss version` reports. `patch === null` ⇒ git unavailable ⇒ `semver` is the raw package.json version. */
export interface CliVersion {
  /** Full rendered version, e.g. `1.0.412+8c1f2ab` or `1.0.412+8c1f2ab.dirty`. */
  semver: string;
  /** `major.minor` from package.json, e.g. `1.0`. */
  base: string;
  /** Auto patch — commits reaching HEAD that touch the CLI package; null when git failed. */
  patch: number | null;
  /** Short (7-char) HEAD sha, `''` when unresolvable. */
  sha: string;
  /** The checkout has uncommitted tracked changes (repo-wide — the honest marker). */
  dirty: boolean;
}

export interface CliVersionInput {
  /** package.json `version` — supplies `major.minor`, and the whole fallback. */
  pkgVersion: string;
  /** The CLI package root (`this.config.root`) — `git -C` works from any subdir. */
  pkgRoot: string;
  /** Injectable git seam (tests); default `makeRealGitRunner()` is supplied by the caller. */
  git: GitRunner;
}

/** Compute the runtime version. Pathspec `.` under `-C <pkgRoot>` scopes the count to the package. */
export async function computeCliVersion({ pkgVersion, pkgRoot, git }: CliVersionInput): Promise<CliVersion> {
  const base = pkgVersion.split('.').slice(0, 2).join('.');
  const [patch, headSha, porcelain] = await Promise.all([
    git.commitCount(pkgRoot, '.'),
    git.headSha(pkgRoot),
    git.statusPorcelain(pkgRoot),
  ]);
  const sha = headSha.slice(0, 7);
  const dirty = hasTrackedChanges(porcelain);
  if (patch === null) {
    // Git unavailable — fold to the static package.json version, unadorned.
    return { semver: pkgVersion, base, patch: null, sha, dirty };
  }
  const meta = sha === '' ? '' : `+${sha}${dirty ? '.dirty' : ''}`;
  return { semver: `${base}.${patch}${meta}`, base, patch, sha, dirty };
}
