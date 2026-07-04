/**
 * overlay ORCHESTRATOR — the native git-overlay engine (M10; a byte-faithful port of
 * refresh-suite.sh's git half: refresh_repo 125-195 and the --reset loop 376-408).
 *
 * Drives the injectable `GitRunner` + `GhRunner` seams per repo to rebuild each
 * managed repo's LOCAL-ONLY `local/integration` branch = `origin/<base>` + a `--no-ff`
 * merge of each given PR/branch, or (reset) to back a repo out to `<base>`. The pure
 * accounting + exit-code decision lives in `core/overlay-plan.ts`; this module does the
 * git IO and assembles the structured outcomes it scores.
 *
 * DESTRUCTIVE MULTI-REPO STATE — ported byte-faithfully (plan hard constraint):
 *   - overridden repos are SKIPPED loudly (an override is a clean detached-main worktree
 *     that `checkout -B` would corrupt) — the command computes `overridden` from the
 *     resolved-path-vs-default comparison (repo_overridden).
 *   - `.git` existence is `existsSync`, NOT is-a-dir: a linked worktree's `.git` is a
 *     FILE, and it is a valid repo (`[[ -e "$repo/.git" ]]`, the `-e` matters).
 *   - refuse when TRACKED changes exist — ONLY non-`??` porcelain lines block; untracked
 *     files (runtime auth dirs, …) survive `checkout -B` and must NOT block.
 *   - a conflicted merge is `merge --abort`ed and recorded, and the rest still apply.
 *   - `local/integration` is LOCAL-ONLY: the `GitRunner` has no push verb, so this
 *     engine structurally cannot push it or add upstream tracking.
 *
 * INVARIANT: git/gh/fs IO lives only here (`src/runtime/**`); the decision is pure core.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyToken,
  splitTokens,
  type RefreshOutcome,
  type ResetOutcome,
} from '../core/overlay-plan.js';
import { hasTrackedChanges } from './git.js';
import type { GitRunner } from './git.js';
import type { GhRunner } from './gh.js';
import { REPO_DEFAULT_DIR, resolveDevRoot, resolveRepoRoot } from './scripts.js';
import type { ScriptContext } from './scripts.js';
import type { RepoKey } from '../core/manifest/types.js';

/** The disposable, LOCAL-ONLY overlay branch (refresh-suite.sh `INT`). NEVER pushed. */
export const INTEGRATION_BRANCH = 'local/integration';

/**
 * refresh-suite.sh's repo NAME → the env-var `RepoKey` its path override is read from.
 * Mirrors `repo_path()` EXACTLY (note: `student-data-system` → `SDS`, and there is NO
 * `coach` entry — refresh-suite doesn't map it, so it falls through to `$DEV/<name>`).
 */
const NAME_TO_REPO_KEY: Record<string, RepoKey> = {
  soa: 'SOA',
  rostering: 'ROSTERING',
  'program-hub': 'PROGRAM_HUB',
  'saga-dash': 'SAGA_DASH',
  'student-data-system': 'SDS',
  qboard: 'QBOARD',
  rtsm: 'RTSM',
  fleek: 'FLEEK',
};

/** A resolved overlay repo: its checkout path + whether it is an override (⇒ skip). */
export interface ResolvedOverlayRepo {
  path: string;
  overridden: boolean;
}

/**
 * Resolve a refresh-suite repo NAME to its checkout path + override flag, reproducing
 * `repo_path()` + `repo_overridden()`:
 *   - a mapped name → `resolveRepoRoot(<key>)` (honours `--<repo>` / `$<REPO>` / default);
 *     overridden iff that resolves to something OTHER than `<dev>/<defaultDir>`.
 *   - an unmapped name → `<dev>/<name>` (refresh-suite's `*)` case), NEVER overridden
 *     (that case has no env override).
 * Pure path building over the same env layering the rest of the CLI uses (no fs).
 */
export function resolveOverlayRepo(name: string, ctx: ScriptContext = {}): ResolvedOverlayRepo {
  const key = NAME_TO_REPO_KEY[name];
  const dev = resolveDevRoot(ctx);
  if (!key) {
    return { path: join(dev, name), overridden: false };
  }
  const path = resolveRepoRoot(key, ctx);
  const def = join(dev, REPO_DEFAULT_DIR[key]);
  return { path, overridden: path !== def };
}

/** The injectable fs read of the personal overlay file (M10 — one `readFileSync`). */
export interface OverlayFs {
  /** Read `integration-suite.local.tsv`'s text, or `null` if the file is absent. */
  readManifest(path: string): string | null;
}

/** The production overlay-fs seam — the only place the overlay file is read. */
export function makeRealOverlayFs(): OverlayFs {
  return {
    readManifest(path: string): string | null {
      // WARN-ONLY guard (verify.sh `[[ -f "$MANIFEST" ]]`): a path that exists but is a
      // directory / unreadable file must degrade to "no local overlay", NOT throw
      // (a throw here would flip `verify --full` to exit 1 — the one hole in the invariant).
      try {
        if (!existsSync(path) || !statSync(path).isFile()) return null;
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** One repo to overlay: resolved path + override flag + its PR/branch set + the base ref. */
export interface RefreshRepoTarget {
  name: string;
  path: string;
  overridden: boolean;
  prsCsv: string;
  base: string;
}

/** The seams the apply engine drives. */
export interface RefreshDeps {
  git: GitRunner;
  gh: GhRunner;
  /** `[[ -e <path>/.git ]]` predicate — default `fs.existsSync` (accepts a worktree's `.git` FILE). */
  pathExists?: (p: string) => boolean;
}

/**
 * Refresh ONE repo's `local/integration` — a faithful port of refresh_repo (125-195).
 * Never throws: every failure is a structured outcome the accounting scores.
 */
export async function refreshRepo(t: RefreshRepoTarget, deps: RefreshDeps): Promise<RefreshOutcome> {
  const { git, gh } = deps;
  const exists = deps.pathExists ?? ((p: string) => existsSync(p));
  const base = t.base;
  const mk = (
    status: RefreshOutcome['status'],
    extra: Partial<RefreshOutcome> = {},
  ): RefreshOutcome => ({
    name: t.name,
    path: t.path,
    base,
    status,
    merged: [],
    conflicted: [],
    missing: [],
    notFound: [],
    ...extra,
  });

  // Overridden repos are left as-is (see header) — before any git touch.
  if (t.overridden) return mk('overridden');
  // `-e`, not `-d`: a linked worktree's `.git` is a FILE and is a valid repo.
  if (!exists(join(t.path, '.git'))) return mk('not-git');
  // Only TRACKED changes (non-`??`) block; untracked files survive `checkout -B`.
  if (hasTrackedChanges(await git.statusPorcelain(t.path))) return mk('dirty');
  // Fetch is network IO — a failure skips this repo, never aborts the whole pass.
  if (!(await git.fetch(t.path))) return mk('fetch-failed');
  if (!(await git.revParseVerify(t.path, `origin/${base}`))) return mk('base-missing');

  // (Re)create local/integration at origin/<base>. Untracked files survive.
  await git.checkoutB(t.path, INTEGRATION_BRANCH, `origin/${base}`);

  // Resolve every token to a branch FIRST (numeric → gh head ref, per-repo cwd; else
  // literal). A PR gh can't resolve is warn-only (notFound) — not a failure.
  const branches: string[] = [];
  const notFound: string[] = [];
  for (const tok of splitTokens(t.prsCsv)) {
    const c = classifyToken(tok);
    if (c.kind === 'pr') {
      const ref = await gh.prHeadRef(c.pr, t.path);
      if (ref) branches.push(ref);
      else notFound.push(c.pr);
    } else {
      branches.push(c.branch);
    }
  }

  if (branches.length === 0) return mk('no-prs', { notFound });

  // Merge each resolved branch: missing on origin → record; conflict → abort + record.
  const merged: string[] = [];
  const conflicted: string[] = [];
  const missing: string[] = [];
  for (const b of branches) {
    if (!(await git.revParseVerify(t.path, `origin/${b}`))) {
      missing.push(b);
      continue;
    }
    if (await git.merge(t.path, `origin/${b}`, { noFf: true, noEdit: true })) {
      merged.push(b);
    } else {
      await git.mergeAbort(t.path);
      conflicted.push(b);
    }
  }
  return mk('merged', { merged, conflicted, missing, notFound });
}

/** Apply the overlay across every target repo, in order (the file-driven / ad-hoc loop). */
export async function applyOverlay(
  targets: RefreshRepoTarget[],
  deps: RefreshDeps,
): Promise<RefreshOutcome[]> {
  const outcomes: RefreshOutcome[] = [];
  for (const t of targets) outcomes.push(await refreshRepo(t, deps));
  return outcomes;
}

/** One repo to reset: resolved path + override flag + the base to restore. */
export interface ResetRepoTarget {
  name: string;
  path: string;
  overridden: boolean;
  base: string;
}

/** The seams the reset engine drives (no gh — reset never resolves PRs). */
export interface ResetDeps {
  git: GitRunner;
  pathExists?: (p: string) => boolean;
}

/**
 * Reset ONE repo back to `<base>` — a faithful port of the --reset loop body (380-403).
 * Never throws; returns a structured outcome the accounting scores.
 */
export async function resetRepo(t: ResetRepoTarget, deps: ResetDeps): Promise<ResetOutcome> {
  const { git } = deps;
  const exists = deps.pathExists ?? ((p: string) => existsSync(p));
  const mk = (status: ResetOutcome['status'], extra: Partial<ResetOutcome> = {}): ResetOutcome => ({
    name: t.name,
    path: t.path,
    base: t.base,
    status,
    ...extra,
  });

  if (t.overridden) return mk('overridden');
  // `-e`, not `-d` — a worktree's `.git` is a file. A missing repo warns+skips (rc 0).
  if (!exists(join(t.path, '.git'))) return mk('not-git');

  const cur = await git.branchShowCurrent(t.path);
  if (cur !== INTEGRATION_BRANCH) {
    // Already backed out. Prune a stale local/integration if one is lying around.
    let deletedStale = false;
    if (await git.revParseVerify(t.path, INTEGRATION_BRANCH)) {
      deletedStale = await git.branchDelete(t.path, INTEGRATION_BRANCH); // report removed only if delete succeeded (bash && chain)
    }
    return mk('not-overlaid', { branch: cur, deletedStale });
  }

  // On local/integration: only TRACKED changes block the backout.
  if (hasTrackedChanges(await git.statusPorcelain(t.path))) return mk('dirty');

  if (await git.checkout(t.path, t.base)) {
    await git.branchDelete(t.path, INTEGRATION_BRANCH);
    return mk('reset');
  }
  return mk('checkout-failed');
}

/** Reset every target repo back to base, in order (the --reset loop). */
export async function resetOverlay(targets: ResetRepoTarget[], deps: ResetDeps): Promise<ResetOutcome[]> {
  const outcomes: ResetOutcome[] = [];
  for (const t of targets) outcomes.push(await resetRepo(t, deps));
  return outcomes;
}
