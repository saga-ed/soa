/**
 * verify-posture — the PURE source-posture (P1–P4) assessment for `stack verify --full`
 * (M12; a faithful port of verify.sh's `── source posture ──` + `── freshness ──`
 * sections, ~138-288).
 *
 * OVERRIDING INVARIANT — STRICTLY WARN-ONLY. verify.sh's P1–P4 checks NEVER flip the
 * exit code: they only print `⚠`/`✓`/`·` lines; the verdict is driven by health + the
 * M9 DATA checks alone. This module ENFORCES that structurally — every function returns
 * `PostureLine`s whose only levels are `ok` / `warn` / `note`. There is NO `fail` level,
 * so posture CANNOT contribute to the verify exit code, by construction. The primary
 * defect this design rules out (a native port that hardens drift — a wrong branch, an
 * unmerged pin, an unpinned overlay, a behind-origin repo — into a verify FAILURE) is
 * impossible here: none of these can produce anything but a warning.
 *
 * (Note: verify.sh's lone posture `badline` — a managed repo whose `.git` is missing —
 * is DELIBERATELY downgraded to a WARN in this native port. That is strictly safer and
 * satisfies "P1–P4 never change verify's pass/fail verdict"; a genuinely absent repo is
 * already surfaced by the native health/DATA gates. See `assessNotGit`.)
 *
 * The four checks (verify.sh):
 *   P1 branch      — is each managed repo on its expected branch? (main, or
 *                    local/integration when overlaid). `assessBranch` / `assessMainBranch`.
 *   P2 pin-merged  — for each pinned PR, is its head SHA an ancestor of HEAD? `assessPinMerged`.
 *   P3 unpinned    — branches merged into local/integration that the overlay file does NOT
 *                    pin (set-subtraction: merged-minus-pinned). `extractMergedOverlayBranches`
 *                    + `computeUnpinnedOverlays` + `unpinnedOverlayLines`.
 *   P4 freshness   — is each repo behind origin/main? `assessFreshness`.
 *
 * The RUNTIME (`runtime/verify-posture.ts`) gathers the git/gh observations in verify.sh's
 * exact short-circuit order and feeds them here; THIS decides the (warn-only) lines.
 *
 * PURITY: no git, no gh, no fs. `src/core/**` never imports `src/runtime/**`.
 */

/** The repos verify.sh postures by default (its OWN `MANAGED_REPOS` — note it includes
 * qboard + rtsm, unlike the overlay engine's smaller managed set). */
export const POSTURE_MANAGED_REPOS = ['rostering', 'program-hub', 'saga-dash', 'qboard', 'rtsm'] as const;
/** Repos verify.sh asserts are literally on main (verify.sh `ALWAYS_MAIN_REPOS`); soa is
 * the one exception — a soa overlay row postures it like a managed repo (the soa-self escape). */
export const POSTURE_ALWAYS_MAIN_REPOS = ['soa', 'student-data-system'] as const;
/** The disposable, local-only overlay branch (verify.sh `local/integration`). */
export const INTEGRATION_BRANCH = 'local/integration';

/** A posture line. LEVELS ARE WARN-ONLY BY DESIGN — there is no `fail`, so posture can
 * never flip verify's exit code. `note` is verify.sh's dim `·` info line. */
export type PostureLevel = 'ok' | 'warn' | 'note';

/** One rendered posture line (a `✓`/`⚠`/`·` message; never a failure). */
export interface PostureLine {
  level: PostureLevel;
  message: string;
}

/** Pad a repo name to verify.sh's `%-20s` column so lines align. */
function pad20(name: string): string {
  return name.padEnd(20);
}

const ok = (message: string): PostureLine => ({ level: 'ok', message });
const warn = (message: string): PostureLine => ({ level: 'warn', message });

/**
 * A managed / always-main repo whose `.git` is absent. verify.sh emits a `badline` here
 * (its ONLY posture failure); this native port DOWNGRADES it to a warn so posture stays
 * strictly warn-only (see module header). Never a failure.
 */
export function assessNotGit(repo: string, dir: string): PostureLine {
  return warn(`${repo}: not a git repo at ${dir} (warn)`);
}

/**
 * An overlay row naming a repo verify.sh can't posture-check (not in MANAGED_REPOS/soa) —
 * verify.sh's guard loop `warnline "overlay lists '$repo' … (warn)"`. Warn, never a failure.
 */
export function assessUnknownOverlayRepo(repo: string): PostureLine {
  return warn(`overlay lists '${repo}' but it's not postureable — verify can't posture-check it (warn)`);
}

/**
 * P1 (pinned repo) — expected on `local/integration`. verify.sh `check_posture repo
 * local/integration`: ok iff the branch matches, else a posture-drift WARN.
 */
export function assessBranch(repo: string, have: string, want: string): PostureLine {
  return have === want
    ? ok(`${pad20(repo)}on ${want}`)
    : warn(`${pad20(repo)}on '${have}' (expected '${want}') — posture drift (warn)`);
}

/**
 * P1 (un-pinned managed repo) — expected on `main`, verify.sh `check_posture_main`. An
 * empty `local/integration` (built as origin/main + zero PRs) is IDENTICAL to main, so it
 * is accepted when `origin/main == HEAD` (the `git diff --quiet origin/main HEAD` gate).
 * Anything else is a posture-drift WARN. `mainEqualsHead` is that diff-quiet result (only
 * consulted on local/integration; ignored otherwise).
 */
export function assessMainBranch(repo: string, have: string, mainEqualsHead: boolean): PostureLine {
  if (have === 'main') return ok(`${pad20(repo)}on main`);
  if (have === INTEGRATION_BRANCH && mainEqualsHead) {
    return ok(`${pad20(repo)}on local/integration ≡ main (no overlay)`);
  }
  return warn(`${pad20(repo)}on '${have}' (expected 'main') — posture drift (warn)`);
}

/**
 * P2 — is pinned PR `#n` merged into the checkout? verify.sh `check_pin_merged`: resolve
 * the PR head SHA via gh, then `merge-base --is-ancestor <oid> HEAD`.
 *   - `oid === ''` (gh couldn't resolve — auth / missing PR): a "couldn't check" WARN.
 *   - ancestor: `✓ #n merged in`.
 *   - not ancestor: `⚠ #n NOT in checkout` WARN.
 * gh-offline and a stale pin BOTH degrade to a warn — never a failure or a throw.
 */
export function assessPinMerged(repo: string, pr: string, oid: string, isAncestor: boolean): PostureLine {
  if (oid === '') {
    return warn(`${repo} #${pr}: couldn't resolve head via gh (auth? PR exists?) (warn)`);
  }
  return isAncestor
    ? ok(`${pad20(repo)}#${pr} merged in`)
    : warn(`${pad20(repo)}#${pr} NOT in checkout — run \`stack overlay apply\` (warn)`);
}

/**
 * P3 (extraction) — the sed-equivalent of verify.sh's branch extraction from the merge
 * subjects of `origin/main..HEAD`. verify.sh pipes the merge subjects through a
 * `sed -nE` that captures `<branch>` from every subject of the form
 * `Merge remote-tracking branch 'origin/<branch>'…`, then `grep -vxE 'main|master'`
 * and `sort -u`. Here: for each such subject take `<branch>`; drop `main`/`master`;
 * return unique + byte-sorted. A subject that doesn't match yields nothing.
 */
export function extractMergedOverlayBranches(logSubjects: string): string[] {
  const out = new Set<string>();
  const re = /Merge remote-tracking branch 'origin\/([^']+)'/;
  for (const line of logSubjects.split('\n')) {
    const m = re.exec(line);
    const branch = m?.[1];
    if (!branch) continue;
    if (branch === 'main' || branch === 'master') continue;
    out.add(branch);
  }
  // `sort -u` — byte-sorted unique.
  return [...out].sort();
}

/**
 * P3 (set-subtraction) — the merged overlay branches MINUS the pinned branches. verify.sh
 * builds `PINNED_BRANCH` (each pinned PR# → its gh headRefName) and drops any merged branch
 * present there; whatever remains is an UNPINNED overlay (a legitimate ad-hoc `--prs` merge
 * that the overlay file doesn't list). Pure set-difference over the two branch lists.
 */
export function computeUnpinnedOverlays(mergedBranches: string[], pinnedBranches: string[]): string[] {
  const pinned = new Set(pinnedBranches);
  return mergedBranches.filter((b) => !pinned.has(b));
}

/** One unpinned overlay: its branch + (optional) resolved PR number for the `#n` decoration. */
export interface UnpinnedOverlay {
  branch: string;
  /** gh-resolved PR number, or `''` when unknown (decoration only). */
  num: string;
}

/**
 * P3 (render) — verify.sh's two warn lines for a repo carrying unpinned overlays: the count
 * + `#num branch` list, then the "ad-hoc … dropped on next refresh" caveat. Empty extras ⇒
 * no lines. Both WARN (never a failure).
 */
export function unpinnedOverlayLines(repo: string, extras: UnpinnedOverlay[]): PostureLine[] {
  if (extras.length === 0) return [];
  const list = extras.map((e) => (e.num ? `#${e.num} ${e.branch}` : e.branch)).join(' ');
  return [
    warn(`${pad20(repo)}+${extras.length} unpinned overlay(s): ${list}`),
    warn(`${pad20('')}  ad-hoc (overlay apply --prs) — not in your overlay; dropped on next apply`),
  ];
}

/**
 * P4 freshness — is the repo behind origin/main? verify.sh: fetch, then
 * `rev-list --count HEAD..origin/main`.
 *   - `!fetchOk`      → `⚠ fetch failed — freshness unknown` (network IO folds to a warn).
 *   - `behind === null` → `⚠ could not compare to origin/main` (verify.sh's `?`).
 *   - `behind === 0`  → `✓ current with origin/main`.
 *   - `behind > 0`    → `⚠ N behind origin/main` WARN.
 * NOTHING here fails; a fetch failure degrades to a "couldn't check" warn, never a throw.
 */
export function assessFreshness(repo: string, fetchOk: boolean, behind: number | null): PostureLine {
  if (!fetchOk) return warn(`${pad20(repo)}fetch failed — freshness unknown`);
  if (behind === null) return warn(`${pad20(repo)}could not compare to origin/main`);
  if (behind === 0) return ok(`${pad20(repo)}current with origin/main`);
  return warn(`${pad20(repo)}${behind} behind origin/main — run \`stack up --pull\``);
}

/** A branch is a freshness candidate only on main / local/integration (verify.sh's `case`). */
export function isFreshnessCandidate(branch: string): boolean {
  return branch === 'main' || branch === INTEGRATION_BRANCH;
}
