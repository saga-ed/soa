/**
 * verify-posture ORCHESTRATOR — the native source-posture (P1–P4) pass for `stack verify
 * --full` (M12; a byte-faithful port of verify.sh's `── source posture ──` +
 * `── freshness ──` sections, ~138-288).
 *
 * Drives the injectable `GitRunner` + `GhRunner` seams per repo, in verify.sh's exact
 * short-circuit order, gathering the observations the PURE decision (`core/verify-posture`)
 * scores into warn-only `PostureLine`s. This module does the git/gh IO; the pure module
 * owns every pass/warn decision.
 *
 * STRICTLY WARN-ONLY (plan hard constraint): the pure module has NO `fail` level, so this
 * pass structurally cannot flip verify's exit code. Every read here FOLDS ALL ERRORS to a
 * SAFE answer — a `gh` that's unauthed/offline, a fetch that fails, a missing ref — none
 * throw; they degrade to a "couldn't check" WARN (or a skip). A `gh`-offline P2 or a
 * fetch-failed P4 must NEVER crash the verify or fail it.
 *
 * INVARIANT: git/gh/fs IO lives only here (`src/runtime/**`); the decision is pure core.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTEGRATION_BRANCH,
  POSTURE_ALWAYS_MAIN_REPOS,
  POSTURE_MANAGED_REPOS,
  assessBranch,
  assessFreshness,
  assessMainBranch,
  assessNotGit,
  assessPinMerged,
  assessUnknownOverlayRepo,
  computeUnpinnedOverlays,
  extractMergedOverlayBranches,
  isFreshnessCandidate,
  unpinnedOverlayLines,
  type PostureLine,
  type UnpinnedOverlay,
} from '../core/verify-posture.js';
import type { GitRunner } from './git.js';
import type { GhRunner } from './gh.js';

/** The inputs to the posture pass. */
export interface PostureContext {
  /** repo NAME → its resolved checkout path (the command resolves via `resolveOverlayRepo`). */
  resolvePath: (name: string) => string;
  /** overlay pins: repo name → PR/branch csv (from `parseOverlayTsv`). Empty ⇒ every repo vs main. */
  pins: Map<string, string>;
  git: GitRunner;
  gh: GhRunner;
  /** `[[ -e <path>/.git ]]` predicate — default `fs.existsSync` (accepts a worktree's `.git` FILE). */
  pathExists?: (p: string) => boolean;
}

/** The posture pass result — the two verify.sh sections, each a list of warn-only lines. */
export interface PostureResult {
  /** `── source posture ──` (P1–P3) lines. */
  posture: PostureLine[];
  /** `── freshness ──` (P4) lines. */
  freshness: PostureLine[];
}

/** Split a pinned-PR csv into tokens (verify.sh `IFS=',' … [[ -n "$n" ]]`). */
function splitPins(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** The set of names verify.sh CAN posture-check (managed + the soa-self escape). */
const POSTUREABLE = new Set<string>([...POSTURE_MANAGED_REPOS, 'soa']);

/**
 * Run the full P1–P4 posture pass. Never throws; every line is `ok`/`warn`/`note` (the
 * pure module has no failure level), so this can never flip the verify verdict.
 */
export async function assessPosture(ctx: PostureContext): Promise<PostureResult> {
  const posture: PostureLine[] = [];
  const exists = ctx.pathExists ?? ((p: string) => existsSync(p));

  // Guard: an overlay row naming a repo verify can't posture-check (avoid silent skips).
  for (const repo of ctx.pins.keys()) {
    if (!POSTUREABLE.has(repo)) posture.push(assessUnknownOverlayRepo(repo));
  }

  // ── managed repos: pinned ⇒ local/integration + pin/unpinned checks; else ≡main. ──
  for (const repo of POSTURE_MANAGED_REPOS) {
    const path = ctx.resolvePath(repo);
    if (!exists(join(path, '.git'))) {
      posture.push(assessNotGit(repo, path));
      continue;
    }
    const prs = ctx.pins.get(repo) ?? '';
    if (prs !== '') {
      posture.push(...(await posturePinned(repo, path, prs, ctx)));
    } else {
      posture.push(await postureMain(repo, path, ctx));
    }
  }

  // ── always-main repos: literally main (strict) — except a soa overlay row (soa-self). ──
  for (const repo of POSTURE_ALWAYS_MAIN_REPOS) {
    const path = ctx.resolvePath(repo);
    if (!exists(join(path, '.git'))) {
      posture.push(assessNotGit(repo, path));
      continue;
    }
    const soaPins = repo === 'soa' ? (ctx.pins.get('soa') ?? '') : '';
    if (repo === 'soa' && soaPins !== '') {
      posture.push(...(await posturePinned('soa', path, soaPins, ctx)));
    } else {
      // Strict main equality (verify.sh uses plain `check_posture repo main` here, NOT the
      // ≡main equivalence the managed-unpinned path allows).
      const have = await ctx.git.branchShowCurrent(path);
      posture.push(assessBranch(repo, have, 'main'));
    }
  }

  // ── freshness (P4): fetch + behind origin/main, for on-main/on-integration repos. ──
  const freshness: PostureLine[] = [];
  for (const repo of [...POSTURE_MANAGED_REPOS, ...POSTURE_ALWAYS_MAIN_REPOS]) {
    const path = ctx.resolvePath(repo);
    if (!exists(join(path, '.git'))) continue; // verify.sh `|| continue` (no line)
    const have = await ctx.git.branchShowCurrent(path);
    if (!isFreshnessCandidate(have)) continue; // feature branches already flagged by P1
    const fetchOk = await ctx.git.fetch(path); // network IO — a failure is a warn, never a throw
    const behind = fetchOk ? await ctx.git.countBehindRef(path, 'origin/main') : null;
    freshness.push(assessFreshness(repo, fetchOk, behind));
  }

  return { posture, freshness };
}

/** P1(pinned) + P2 + P3 for a repo expected on `local/integration`. */
async function posturePinned(
  repo: string,
  path: string,
  prs: string,
  ctx: PostureContext,
): Promise<PostureLine[]> {
  const lines: PostureLine[] = [];
  const have = await ctx.git.branchShowCurrent(path);
  lines.push(assessBranch(repo, have, INTEGRATION_BRANCH));
  // Pin/unpinned checks are only meaningful when the branch is actually integration.
  if (have !== INTEGRATION_BRANCH) return lines;

  const nums = splitPins(prs);
  // P2 — each pinned PR merged into the checkout? (gh head SHA is an ancestor of HEAD).
  for (const n of nums) {
    const oid = await ctx.gh.prHeadOid(n, path); // '' on any gh error ⇒ "couldn't check" warn
    const isAncestor = oid !== '' ? await ctx.git.mergeBaseIsAncestor(path, oid, 'HEAD') : false;
    lines.push(assessPinMerged(repo, n, oid, isAncestor));
  }
  // P3 — branches actually overlaid MINUS the pinned set.
  lines.push(...(await unpinnedOverlaysFor(repo, path, nums, ctx)));
  return lines;
}

/** P1 for an un-pinned managed repo — main, or an empty local/integration ≡ main. */
async function postureMain(repo: string, path: string, ctx: PostureContext): Promise<PostureLine> {
  const have = await ctx.git.branchShowCurrent(path);
  // The ≡main gate (`git diff --quiet origin/main HEAD`) is only consulted on integration.
  const mainEqualsHead =
    have === INTEGRATION_BRANCH ? await ctx.git.diffQuiet(path, 'origin/main', 'HEAD') : false;
  return assessMainBranch(repo, have, mainEqualsHead);
}

/** P3 — resolve the merged-minus-pinned set + decorate each with its PR number. */
async function unpinnedOverlaysFor(
  repo: string,
  path: string,
  pinnedNums: string[],
  ctx: PostureContext,
): Promise<PostureLine[]> {
  const merged = extractMergedOverlayBranches(await ctx.git.logMergeSubjects(path, 'origin/main..HEAD'));
  if (merged.length === 0) return [];

  // Resolve each pinned PR# → its head branch (the branch that got merged) for the subtraction.
  const pinnedBranches: string[] = [];
  for (const n of pinnedNums) {
    const b = await ctx.gh.prHeadRef(n, path);
    if (b !== '') pinnedBranches.push(b);
  }

  const extraBranches = computeUnpinnedOverlays(merged, pinnedBranches);
  const extras: UnpinnedOverlay[] = [];
  for (const b of extraBranches) {
    const num = await ctx.gh.prNumberForHead(b, path); // '' on any gh error (decoration only)
    extras.push({ branch: b, num });
  }
  return unpinnedOverlayLines(repo, extras);
}
