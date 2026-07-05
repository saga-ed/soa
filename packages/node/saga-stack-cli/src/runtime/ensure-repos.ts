/**
 * `ensureReposNative` — the delta bootstrap.sh's step 1 (`ensure_repos`, ~76-122).
 *
 * bootstrap.sh clones any MISSING of the 7 required sibling repos before standing the
 * stack up. Native-parity's other three steps are already native (overlay = M10, up
 * --reset --seed = StackApi.up, verify = native); the CLONE decision is the only gap,
 * so this module owns exactly that: derive the required repos, check each is present via
 * a WORKTREE-SAFE `.git` marker, and — only after the right confirm — clone the missing
 * ones through the injectable `GitRunner.clone` seam.
 *
 * DO NOT SILENTLY AUTO-CLONE (plan hard constraint — bootstrap.sh's confirm semantics):
 *   - `--yes` auto-confirms.
 *   - otherwise, NO TTY ⇒ ABORT (`aborted:'no-tty'`), never clone (bootstrap.sh `! -t 0`).
 *   - otherwise, prompt `[y/N]`; anything but a `y*` answer ABORTS (`aborted:'declined'`).
 * So the ONLY paths that clone are `--yes`, or TTY + user-said-yes.
 *
 * WORKTREE-SAFE marker: present iff `<path>/.git` EXISTS (`existsSync`), NOT is-a-dir — a
 * linked `git worktree`'s `.git` is a FILE, and cloning OVER a populated worktree is the
 * exact bug bootstrap.sh guards (`[[ ! -e "$dir/.git" ]]`, the `-e` matters).
 *
 * The install half (co:login + `pnpm install`) is NOT here: native prep (FLIP 4) installs
 * on `up`, so ensure-repos only needs to make the checkouts EXIST. IO is behind seams.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import type { RepoKey } from '../core/manifest/types.js';
import type { GitRunner } from './git.js';
import { REPO_DEFAULT_DIR, resolveRepoRoot } from './scripts.js';
import type { ScriptContext } from './scripts.js';

/** The GitHub org the sibling repos live under (bootstrap.sh `git@github.com:saga-ed/…`). */
export const GITHUB_ORG = 'saga-ed';

/**
 * Repos EXCLUDED from bootstrap's required set (bootstrap.sh's step-1 loop lists 7 of the
 * 9 manifest repos — coach + fleek are optional and not provisioned here).
 */
const EXCLUDED_FROM_BOOTSTRAP: readonly RepoKey[] = ['COACH', 'FLEEK'];

/**
 * The 7 REQUIRED bootstrap repos, derived from the manifest repo set MINUS coach/fleek —
 * NOT a hand-maintained list, so it can't drift from the manifest. In manifest-declaration
 * order this is exactly bootstrap.sh's loop:
 *   soa rostering program-hub saga-dash student-data-system qboard rtsm
 */
export const REQUIRED_BOOTSTRAP_REPOS: RepoKey[] = (
  Object.keys(REPO_DEFAULT_DIR) as RepoKey[]
).filter((r) => !EXCLUDED_FROM_BOOTSTRAP.includes(r));

/** The SSH clone URL for a repo's default dir name (bootstrap.sh `git@github.com:saga-ed/<name>.git`). */
export function cloneUrl(dirName: string): string {
  return `git@github.com:${GITHUB_ORG}/${dirName}.git`;
}

/** One required repo: its dir name, resolved checkout path, and clone URL. */
export interface EnsureRepo {
  /** The default dir name (e.g. `student-data-system`) — also the github repo name. */
  name: string;
  /** The RESOLVED checkout path (honours `--<repo>`/`$<REPO>`/`--dev`; an override clones there). */
  path: string;
  /** `git@github.com:saga-ed/<name>.git`. */
  url: string;
}

/**
 * Resolve the required bootstrap repos to `{ name, path, url }` using the SAME repo-root
 * precedence the rest of the CLI uses (`resolveRepoRoot` = `--<repo>` → `$<REPO>` →
 * `<dev>/<defaultDir>`), so bootstrap provisions exactly the checkout `up` will run. Pure.
 */
export function bootstrapRepos(ctx: ScriptContext = {}): EnsureRepo[] {
  return REQUIRED_BOOTSTRAP_REPOS.map((repo) => {
    const name = REPO_DEFAULT_DIR[repo];
    return { name, path: resolveRepoRoot(repo, ctx), url: cloneUrl(name) };
  });
}

/**
 * The injectable confirm seam (isTTY + readline) — bootstrap.sh's `[[ ! -t 0 ]]` + `read`.
 * Injected so the confirm/abort/clone decision is unit-tested with NO real TTY.
 */
export interface ConfirmSeam {
  /** True iff stdin is a TTY (bootstrap.sh's `-t 0` test). */
  isTTY(): boolean;
  /** Prompt `question` and resolve true iff the answer starts with `y`/`Y` (bootstrap.sh `[yY]*`). */
  prompt(question: string): Promise<boolean>;
}

/**
 * The production confirm seam: `process.stdin.isTTY` + a one-shot readline prompt.
 * The ONLY place the bootstrap provisioning prompt reads the user's TTY.
 */
export function makeRealConfirm(): ConfirmSeam {
  return {
    isTTY(): boolean {
      return Boolean(process.stdin.isTTY);
    },
    async prompt(question: string): Promise<boolean> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        return /^[yY]/.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** The seams `ensureReposNative` drives. */
export interface EnsureReposDeps {
  /** git seam — only `clone` is used (stdio inherited in production). */
  git: Pick<GitRunner, 'clone'>;
  /** TTY + prompt seam. */
  confirm: ConfirmSeam;
  /** `[[ -e <path>/.git ]]` predicate — default `fs.existsSync` (accepts a worktree's `.git` FILE). */
  pathExists?: (p: string) => boolean;
  /** Optional human-line sink (the command injects `this.log`); tests may omit it. */
  notify?: (msg: string) => void;
}

/** Why `ensureReposNative` gave up WITHOUT cloning (or a clone failed). */
export type EnsureAbort = 'no-tty' | 'declined' | 'clone-failed';

/** The outcome of `ensureReposNative`. */
export interface EnsureReposResult {
  /** True iff every required repo is now present (nothing to clone, or all clones succeeded). */
  ok: boolean;
  /** Repos already present (a `.git` marker existed) — never cloned. */
  present: string[];
  /** Repos actually cloned this run. */
  cloned: string[];
  /** Repos that were MISSING (needed cloning) — the provisioning list. */
  needed: string[];
  /** Set only when `ok:false`: why we stopped. */
  aborted?: EnsureAbort;
  /** Set only when `aborted:'clone-failed'`: the repo whose clone failed. */
  failedRepo?: string;
}

/**
 * Ensure the required sibling repos exist, cloning missing ones only after the correct
 * confirm (see the module header). Never throws — every giving-up path returns a
 * structured `ok:false` result the command renders + exits on. `--yes` auto-confirms.
 */
export async function ensureReposNative(
  repos: EnsureRepo[],
  opts: { yes: boolean },
  deps: EnsureReposDeps,
): Promise<EnsureReposResult> {
  const exists = deps.pathExists ?? ((p: string) => existsSync(p));
  const notify = deps.notify ?? ((): void => {});

  const present: string[] = [];
  const needed: EnsureRepo[] = [];
  for (const r of repos) {
    // `-e`, NOT `-d`: a linked worktree's `.git` is a FILE and still counts as present.
    if (exists(join(r.path, '.git'))) present.push(r.name);
    else needed.push(r);
  }

  if (needed.length === 0) {
    notify(`✓ all ${repos.length} required sibling repo(s) present`);
    return { ok: true, present, cloned: [], needed: [] };
  }

  const neededNames = needed.map((n) => n.name);
  notify(`✗ ${needed.length} sibling repo(s) need cloning:`);
  for (const r of needed) notify(`    ${r.name.padEnd(20)} → ${r.path}`);

  // CONFIRM (bootstrap.sh's confirm semantics) — the only paths that clone are
  // `--yes`, or an interactive TTY where the user answered yes.
  if (!opts.yes) {
    if (!deps.confirm.isTTY()) {
      return { ok: false, present, cloned: [], needed: neededNames, aborted: 'no-tty' };
    }
    const yes = await deps.confirm.prompt('  Clone the repo(s) above now? [y/N] ');
    if (!yes) {
      return { ok: false, present, cloned: [], needed: neededNames, aborted: 'declined' };
    }
  }

  const cloned: string[] = [];
  for (const r of needed) {
    notify(`→ cloning ${r.name} → ${r.path}…`);
    if (!(await deps.git.clone(r.url, r.path))) {
      return { ok: false, present, cloned, needed: neededNames, aborted: 'clone-failed', failedRepo: r.name };
    }
    cloned.push(r.name);
  }

  return { ok: true, present, cloned, needed: neededNames };
}
