/**
 * auto-pull orchestrator (M9 — up.sh `pull_repos`, ~959-990 + the invocation at
 * 2261-2265).
 *
 * Drives the ff-only sibling sync: for each repo it gathers the git observations the
 * pure decision (`core/auto-pull.ts`) needs, in up.sh's SHORT-CIRCUIT order (so a
 * repo skipped before the fetch is never fetched), then performs the one mutating
 * `merge --ff-only` for the ff intent. Every per-repo issue is warn-and-continue —
 * in particular a FETCH FAILURE (network IO) skips that repo but NEVER aborts the up
 * (plan hard constraint).
 *
 * The git IO is the injectable `GitRunner` seam and the `.git` existence check is an
 * injectable `pathExists` (default `fs.existsSync`), so the whole pass is unit-tested
 * with fakes — no real git/network/fs.
 *
 * INVARIANT: IO lives only in `src/runtime/**`; the DECISION lives in `src/core/**`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyPostFetch,
  classifyPreFetch,
  divergedMessage,
  ffOkMessage,
} from '../core/auto-pull.js';
import type { PullMode } from '../core/auto-pull.js';
import { hasTrackedChanges } from './git.js';
import type { GitRunner } from './git.js';

/** One sibling repo to (maybe) sync: its display name + resolved checkout path. */
export interface AutoPullRepo {
  /** up.sh's repo label (e.g. `soa`, `student-data-system`). */
  name: string;
  /** Absolute checkout path (`git -C <path>` + the `<path>/.git` existence check). */
  path: string;
}

/** What the pass did for one repo (drives the command-layer report). */
export interface RepoPullOutcome {
  name: string;
  /** Terminal action: skipped (with a reason), left as-is (off-default), already current, ff'd, or diverged. */
  action: 'skip' | 'leave' | 'up-to-date' | 'ff' | 'diverged';
  /** Skip reason (only for `action: 'skip'`). */
  reason?: 'not-cloned' | 'dirty' | 'detached' | 'fetch-failed' | 'no-upstream';
  /** Commits fast-forwarded (only for `action: 'ff'`). */
  behind?: number;
  /** The human-readable line (up.sh's `⚠`/`·`/`✓` note). */
  message: string;
}

/** The outcome of the whole auto-pull pass. */
export interface AutoPullResult {
  mode: PullMode;
  repos: RepoPullOutcome[];
}

/** Inputs to the auto-pull pass. */
export interface AutoPullContext {
  /** The siblings to sync (name + path). */
  repos: AutoPullRepo[];
  /** `auto` (default pre-build sync) or `all` (explicit `--pull`). */
  mode: PullMode;
  /** The ff-only git seam. */
  git: GitRunner;
  /** `[[ -e <path>/.git ]]` predicate. Default `fs.existsSync`. */
  pathExists?: (p: string) => boolean;
}

/**
 * Run the ff-only sync over `ctx.repos`. Per repo: gather the pre-fetch observations
 * → `classifyPreFetch`; on `proceed` fetch + gather upstream/behind →
 * `classifyPostFetch`; on an `ff` intent run `merge --ff-only` and report ff or
 * diverged. Never throws (a per-repo issue is recorded and the pass continues).
 */
export async function autoPullRepos(ctx: AutoPullContext): Promise<AutoPullResult> {
  const pathExists = ctx.pathExists ?? ((p: string) => existsSync(p));
  const { git, mode } = ctx;
  const repos: RepoPullOutcome[] = [];

  for (const repo of ctx.repos) {
    const { name, path } = repo;
    const cloned = pathExists(join(path, '.git'));

    // Only touch git for a real checkout — otherwise pass the placeholders the
    // not-cloned gate short-circuits on (dirty:false / branch:'').
    const dirty = cloned ? hasTrackedChanges(await git.statusPorcelain(path)) : false;
    const branch = cloned ? await git.branchShowCurrent(path) : '';
    // Default branch only matters in `auto` mode; skip the extra git call otherwise.
    const defaultBranch = cloned && mode === 'auto' ? await git.symbolicRefDefault(path) : '';

    const pre = classifyPreFetch({ name, cloned, dirty, branch, mode, defaultBranch });
    if (pre.kind === 'skip') {
      repos.push({ name, action: 'skip', reason: pre.reason, message: pre.message });
      continue;
    }
    if (pre.kind === 'leave') {
      repos.push({ name, action: 'leave', message: pre.message });
      continue;
    }

    // proceed → fetch (network IO — a failure skips this repo, never aborts).
    const fetchOk = await git.fetch(path);
    const hasUpstream = fetchOk ? await git.hasUpstream(path) : false;
    const behind = fetchOk && hasUpstream ? await git.revListCount(path) : 0;

    const post = classifyPostFetch({ name, branch, fetchOk, hasUpstream, behind });
    if (post.kind === 'skip') {
      repos.push({ name, action: 'skip', reason: post.reason, message: post.message });
      continue;
    }
    if (post.kind === 'up-to-date') {
      repos.push({ name, action: 'up-to-date', message: post.message });
      continue;
    }

    // ff intent — the ONE mutating op. ff-only merge; a non-zero exit ⇒ diverged.
    const ffOk = await git.mergeFfOnly(path);
    if (ffOk) {
      repos.push({ name, action: 'ff', behind: post.behind, message: ffOkMessage(name, branch, post.behind) });
    } else {
      repos.push({ name, action: 'diverged', message: divergedMessage(name, branch) });
    }
  }

  return { mode, repos };
}
