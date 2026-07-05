/**
 * Worktree sets — the PURE schema + resolution half of M13-A (plan
 * `10-m13-worktree-sets.md` §1-§3, saga-ed/soa#214).
 *
 * A worktree set is a named map of `repo → checkout path` bound to a slot, so
 * devs run independent multi-repo/multi-branch contexts on `ss` slots
 * concurrently. This module owns:
 *
 *   - the zod schema for `worktree-sets.json` (`{version, sets:{name → {slot,
 *     repos, note?}}}`) with the M13 validation rules: kebab flag-name repo
 *     keys (did-you-mean on a typo), slot REQUIRED in 1..9 (slot 0 is the
 *     baseline/primary-checkout slot by convention), duplicate slots across
 *     sets rejected, unknown top-level keys tolerated;
 *   - entry normalization: a repo entry is a bare string path (hand-recorded)
 *     OR `{path, createdBy?, createdFrom?}` — `createdBy: 'ss'` marks a
 *     worktree `ss set create` made (gates `rm --and-worktrees`, M13-C) and
 *     `createdFrom` records the creation branch (powers the WARN-only drift
 *     report in `set check`);
 *   - `applySetToFlags` — the parse-choke-point injection that makes every
 *     downstream ScriptContext/repo-env builder honor the set with the
 *     required precedence: user-typed `--<repo>` flag > set map > `$<REPO>`
 *     env (which arrives as an oclif flag DEFAULT) > `$DEV/<repo>` default.
 *
 * PURE: zero IO, no `process.env`, no fs — the file read + `~`/relative path
 * expansion live in `runtime/set-store.ts` (the core/runtime split mirrors
 * `core/flow/types.ts` + `runtime/flows.ts`).
 */

import { z } from 'zod';

/**
 * THE canonical kebab CLI-flag repo keys (M15): `runtime/repos.ts` imports
 * this list (its `RepoKey` is an alias of `SetRepoKey`), so the set-file
 * schema, the CLI flags, and the env-var mapping share one source of truth.
 */
export const SET_REPO_KEYS = [
  'soa',
  'rostering',
  'program-hub',
  'saga-dash',
  'coach',
  'sds',
  'qboard',
  'rtsm',
  'fleek',
] as const;

export type SetRepoKey = (typeof SET_REPO_KEYS)[number];

/** Schema version this build reads/writes. Unknown future versions are rejected. */
export const WORKTREE_SETS_VERSION = 1;

/**
 * Levenshtein distance — tiny and local, used only for the did-you-mean hint
 * on an unknown repo key (9 candidates, strings of ~a dozen chars).
 */
function levenshtein(a: string, b: string): number {
  let prevRow: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (prevRow[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prevRow[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, substitution));
    }
    prevRow = row;
  }
  return prevRow[b.length] ?? 0;
}

/** The closest known repo key to a typo, for the hard-error hint. */
export function nearestRepoKey(unknown: string): SetRepoKey {
  let best: SetRepoKey = SET_REPO_KEYS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const key of SET_REPO_KEYS) {
    const d = levenshtein(unknown, key);
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  return best;
}

/** A normalized repo entry: bare-string entries gain `{path}` shape. */
export interface SetRepoEntry {
  path: string;
  /** `'ss'` iff `ss set create` made the worktree (gates `rm --and-worktrees`). */
  createdBy?: 'ss';
  /** Branch the worktree was created from — powers the WARN-only drift report. */
  createdFrom?: string;
}

const repoEntrySchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    createdBy: z.literal('ss').optional(),
    createdFrom: z.string().min(1).optional(),
  }),
]);

const setEntrySchema = z.object({
  slot: z
    .number()
    .int()
    .min(1, 'slot 0 is reserved for the primary-checkout baseline; sets bind slots 1..9')
    .max(9, 'slot ceiling is 9 (slot 10 would collide rabbitmq with slot 0 rabbitmq-mgmt)'),
  repos: z.record(z.string(), repoEntrySchema),
  note: z.string().optional(),
});

const setsFileSchema = z
  .object({
    version: z.literal(WORKTREE_SETS_VERSION),
    sets: z.record(z.string().min(1), setEntrySchema),
  })
  // Unknown top-level keys tolerated (forward-compat, plan §1.2).
  .passthrough();

/** One fully-validated, normalized worktree set. */
export interface WorktreeSet {
  name: string;
  slot: number;
  repos: Partial<Record<SetRepoKey, SetRepoEntry>>;
  note?: string;
}

/** The validated file: every set normalized, slots unique. */
export interface WorktreeSetsFile {
  version: typeof WORKTREE_SETS_VERSION;
  sets: Record<string, WorktreeSet>;
}

/** An empty store — what a missing sets file parses to. */
export function emptyWorktreeSetsFile(): WorktreeSetsFile {
  return { version: WORKTREE_SETS_VERSION, sets: {} };
}

/**
 * Validate + normalize a parsed `worktree-sets.json` value. Throws an `Error`
 * with a pointed, user-facing message on any M13 schema violation (unknown
 * repo key + did-you-mean, slot out of 1..9, duplicate slot across sets, bad
 * shape/version). Path strings are stored VERBATIM — `~`/relative expansion is
 * the runtime store's job.
 */
export function parseWorktreeSetsFile(data: unknown): WorktreeSetsFile {
  const parsed = setsFileSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue !== undefined && issue.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`worktree-sets: invalid sets file${at}: ${issue?.message ?? 'unknown shape error'}`);
  }

  const known = new Set<string>(SET_REPO_KEYS);
  const slotOwner = new Map<number, string>();
  const sets: Record<string, WorktreeSet> = {};

  for (const [name, entry] of Object.entries(parsed.data.sets)) {
    const owner = slotOwner.get(entry.slot);
    if (owner !== undefined) {
      throw new Error(
        `worktree-sets: sets '${owner}' and '${name}' both declare slot ${entry.slot} — ` +
          'slots are owned one-per-set (edit the file so every set has a distinct slot 1..9).',
      );
    }
    slotOwner.set(entry.slot, name);

    const repos: Partial<Record<SetRepoKey, SetRepoEntry>> = {};
    for (const [repo, value] of Object.entries(entry.repos)) {
      if (!known.has(repo)) {
        throw new Error(
          `worktree-sets: set '${name}' has unknown repo key '${repo}' — did you mean ` +
            `'${nearestRepoKey(repo)}'? Known keys: ${SET_REPO_KEYS.join(', ')}.`,
        );
      }
      repos[repo as SetRepoKey] = typeof value === 'string' ? { path: value } : { ...value };
    }

    sets[name] = { name, slot: entry.slot, repos, ...(entry.note !== undefined ? { note: entry.note } : {}) };
  }

  return { version: WORKTREE_SETS_VERSION, sets };
}

/**
 * Resolve a `--set <name>` against the store. Throws the user-facing
 * unknown-set error (listing the known names) so the caller can pass it
 * straight to `this.error`.
 */
export function resolveSet(file: WorktreeSetsFile, name: string): WorktreeSet {
  const set = file.sets[name];
  if (set === undefined) {
    const names = Object.keys(file.sets);
    throw new Error(
      `worktree-sets: unknown set '${name}'. ` +
        (names.length
          ? `Known sets: ${names.join(', ')}.`
          : 'No sets are defined — create ~/.saga-stack/worktree-sets.json (see `ss set list`).'),
    );
  }
  return set;
}

/** The mutable subset of parsed flags `applySetToFlags` rewrites. */
export type SetInjectableFlags = {
  slot?: number;
} & Partial<Record<SetRepoKey, string>>;

/** The outcome of an injection — what the set actually supplied, for logging/tests. */
export interface SetInjectionResult {
  /** Repo flags the set filled (user-typed flags are never overwritten). */
  applied: SetRepoKey[];
  /** Repo flags kept because the user explicitly typed them. */
  kept: SetRepoKey[];
  /** The slot the flags carry after injection (always the set's slot). */
  slot: number;
}

/**
 * The M13-A injection, applied ONCE at the BaseCommand.parse choke point: every
 * downstream ScriptContext / repo-env / `deriveInstance({slot})` consumer reads
 * the parsed flags bag, so rewriting it here threads the set through all of
 * them (native runtimes, wrapper/vendored child env, status/verify/e2e/down
 * duplicates) with zero per-site changes.
 *
 * `userTyped` is the set of flag names the user ACTUALLY typed (oclif raw
 * tokens) — the only way to tell a typed `--saga-dash` from one defaulted off
 * `$SAGA_DASH` (repo flags bake env vars in as oclif defaults). Precedence:
 *
 *   user-typed flag  — kept (beats the set);
 *   set map          — overwrites env-defaulted/absent flag values;
 *   env/default      — untouched for repos the set does not pin.
 *
 * The slot check is the caller's job (`--set X --slot N` mismatch is a hard
 * error BEFORE injection); this function unconditionally stamps the set's slot.
 */
export function applySetToFlags(
  flags: SetInjectableFlags,
  userTyped: ReadonlySet<string>,
  set: WorktreeSet,
): SetInjectionResult {
  const applied: SetRepoKey[] = [];
  const kept: SetRepoKey[] = [];

  for (const repo of Object.keys(set.repos) as SetRepoKey[]) {
    const entry = set.repos[repo];
    if (entry === undefined) continue;
    if (userTyped.has(repo)) {
      kept.push(repo);
      continue;
    }
    flags[repo] = entry.path;
    applied.push(repo);
  }

  flags.slot = set.slot;
  return { applied, kept, slot: set.slot };
}
