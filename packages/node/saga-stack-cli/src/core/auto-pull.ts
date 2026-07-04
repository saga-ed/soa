/**
 * auto-pull — the PURE skip/ff decision for the native sibling-repo sync (M9;
 * up.sh `pull_repos`, ~959-990).
 *
 * up.sh's bare `up` keeps passive on-`main` siblings current with an ff-ONLY sync
 * BEFORE it builds/migrates, so the stack never runs a checkout silently behind
 * origin (the trap that 404s/500s on new endpoints). The native-default flips made
 * a bare native `up` load-bearing but it currently skips this sync entirely — this
 * module ports the DECISION half (pure, IO-free); `runtime/auto-pull.ts` drives the
 * git IO through the injectable `GitRunner` seam and performs the ff.
 *
 * The decision is split into the two gates up.sh short-circuits through, so the
 * runtime never fetches a repo it has already decided to skip:
 *   - `classifyPreFetch`  — the pre-network gates: not-cloned / dirty-tracked /
 *     detached / (auto-mode) off-default-branch. Returns `proceed` when the repo is
 *     a fetch candidate.
 *   - `classifyPostFetch` — after the fetch: fetch-failed / no-upstream / up-to-date
 *     / behind→attempt-ff. The ff MERGE itself is IO (runtime), so this returns
 *     `ff` as an INTENT; the runtime runs `merge --ff-only` and reports ff vs
 *     diverged from its exit.
 *
 * LOAD-BEARING (plan risk): the default-branch detection (origin/HEAD, fallback
 * `main`) gates the ff in `auto` mode — a wrong test would fast-forward a
 * feature/overlay branch (e.g. `local/integration`) toward main behind the user's
 * back. `auto` mode ONLY touches a repo that is on its default branch, clean, has an
 * upstream, and is strictly behind. `all` mode (explicit `--pull`) syncs every
 * on-branch clean sibling regardless of which branch it is on, but is STILL ff-only
 * and still never touches a dirty/detached tree.
 *
 * PURITY: no git, no fs, no network — every field is an observation the runtime
 * gathered. `src/core/**` never imports `src/runtime/**`.
 */

/** `auto` (default pre-build sync — default-branch siblings only) or `all` (explicit `--pull`). */
export type PullMode = 'auto' | 'all';

/** Why a repo was skipped before any fetch. */
export type PreFetchSkipReason = 'not-cloned' | 'dirty' | 'detached';

/** The pre-fetch gate decision. `proceed` ⇒ the repo is a fetch candidate. */
export type PreFetchDecision =
  | { kind: 'skip'; reason: PreFetchSkipReason; message: string }
  /** auto-mode repo on a non-default branch — left as-is (a `·` note, not a warning). */
  | { kind: 'leave'; message: string }
  | { kind: 'proceed' };

/** What the runtime observed before fetching (all IO-free inputs). */
export interface PreFetchObs {
  /** Display name (up.sh's repo label, e.g. `student-data-system`). */
  name: string;
  /** `[[ -e "$dir/.git" ]]` — the checkout exists. */
  cloned: boolean;
  /** `git status --porcelain | grep -v '^??'` non-empty — TRACKED changes present. */
  dirty: boolean;
  /** `git branch --show-current` — empty string ⇒ detached HEAD. */
  branch: string;
  /** The sync mode. */
  mode: PullMode;
  /** Resolved default branch (origin/HEAD → default, fallback `main`). Only consulted in `auto` mode. */
  defaultBranch: string;
}

/** Why a repo was skipped after the fetch (or the terminal non-ff outcomes). */
export type PostFetchSkipReason = 'fetch-failed' | 'no-upstream';

/** The post-fetch gate decision. `ff` is an INTENT the runtime executes (merge --ff-only). */
export type PostFetchDecision =
  | { kind: 'skip'; reason: PostFetchSkipReason; message: string }
  | { kind: 'up-to-date'; message: string }
  | { kind: 'ff'; behind: number };

/** What the runtime observed after (attempting) the fetch. */
export interface PostFetchObs {
  name: string;
  branch: string;
  /** `git fetch -q origin` exited 0. */
  fetchOk: boolean;
  /** `git rev-parse --abbrev-ref @{u}` succeeded — an upstream is configured. */
  hasUpstream: boolean;
  /** `git rev-list --count HEAD..@{u}` — commits behind upstream (0 ⇒ up to date). */
  behind: number;
}

/** Pad a repo name to up.sh's `%-20s` column so the notes line up. */
function pad(name: string): string {
  return name.padEnd(20);
}

/**
 * The pre-network gate: reproduce up.sh's not-cloned / dirty / detached /
 * off-default-branch (auto) skip states in order. `proceed` ⇒ the runtime should
 * fetch and re-classify with `classifyPostFetch`.
 */
export function classifyPreFetch(o: PreFetchObs): PreFetchDecision {
  if (!o.cloned) {
    return { kind: 'skip', reason: 'not-cloned', message: `⚠ ${pad(o.name)} not cloned — skipping` };
  }
  if (o.dirty) {
    return { kind: 'skip', reason: 'dirty', message: `⚠ ${pad(o.name)} uncommitted changes — skipping` };
  }
  if (o.branch === '') {
    return { kind: 'skip', reason: 'detached', message: `⚠ ${pad(o.name)} detached HEAD — skipping` };
  }
  // auto mode leaves overlay/feature branches (e.g. local/integration) untouched so
  // WIP is never moved toward main behind your back. `all` mode syncs any branch.
  if (o.mode === 'auto' && o.branch !== o.defaultBranch) {
    return {
      kind: 'leave',
      message: `· ${pad(o.name)} on ${o.branch} (not ${o.defaultBranch}) — leaving overlay/feature branch as-is`,
    };
  }
  return { kind: 'proceed' };
}

/**
 * The post-fetch gate: fetch-failed / no-upstream / up-to-date / behind→ff. Only
 * called for a repo `classifyPreFetch` returned `proceed` for. A `behind > 0` with a
 * live upstream is the ONLY case that returns an ff intent.
 */
export function classifyPostFetch(o: PostFetchObs): PostFetchDecision {
  if (!o.fetchOk) {
    return { kind: 'skip', reason: 'fetch-failed', message: `⚠ ${pad(o.name)} fetch failed — skipping` };
  }
  if (!o.hasUpstream) {
    return { kind: 'skip', reason: 'no-upstream', message: `⚠ ${pad(o.name)} ${o.branch} has no upstream — skipping` };
  }
  if (o.behind <= 0) {
    return { kind: 'up-to-date', message: `✓ ${o.name} up to date (${o.branch})` };
  }
  return { kind: 'ff', behind: o.behind };
}

/** Message for a successful ff (runtime emits after `merge --ff-only` exits 0). */
export function ffOkMessage(name: string, branch: string, behind: number): string {
  return `✓ ${name} fast-forwarded ${behind} commit(s) (${branch})`;
}

/** Message for a diverged repo (runtime emits when `merge --ff-only` exits non-zero). */
export function divergedMessage(name: string, branch: string): string {
  return `⚠ ${pad(name)} ${branch} diverged from upstream — skipping (pull by hand)`;
}
