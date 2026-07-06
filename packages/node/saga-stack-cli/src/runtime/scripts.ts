/**
 * Absolute-path resolution for the unchanged bash scripts the wrappers shell
 * out to. GENERALIZED in M2: a script is named by a `ScriptLocator`
 * (`{ repo, relPath }`) so ANY script in ANY sibling repo can be located, not
 * just `up.sh`/`verify.sh` under `soa`'s synthetic-dev dir.
 *
 * Resolution precedence (matches up.sh's own header, ~lines 167-185):
 *   dev      = `--dev` override → `$DEV` → `$HOME/dev`
 *   repoRoot = `--<repo>` override → `$<REPO>` → `<dev>/<defaultDir>`
 *   command  = `<repoRoot>/<relPath>`
 *   cwd      = the script's own directory (`dirname(command)`)
 *
 * e.g. SOA's `tools/synthetic-dev/up.sh`, or SAGA_DASH's
 * `apps/web/dash/e2e/check-e2e.sh` (note SDS's default checkout dir is
 * `student-data-system`, not `sds` — see `REPO_DEFAULT_DIR`).
 *
 * This module is runtime (not core): it does pure path building plus ONE
 * `existsSync` guard in `resolveScript` so a missing/mis-pathed checkout fails
 * with a clear message instead of an opaque spawn ENOENT. No spawning here.
 * `ScriptLocator` / `RepoKey` are imported as TYPES ONLY from core — type
 * imports erase at compile, so this does not breach the "core stays pure /
 * spawning lives in runtime" boundary (the dependency is runtime → core types,
 * never the reverse, and carries no IO).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScriptLocator } from '../core/flag-map.js';
import type { RepoKey } from '../core/manifest/types.js';

/**
 * The inputs needed to locate a script. `dev` is the `--dev` workspace root;
 * `repoRoots` pins individual repo checkouts (keyed by the manifest `RepoKey` /
 * env-var name, e.g. `{ SOA: '/x/soa', SAGA_DASH: '/y/dash' }`), sourced from
 * the per-repo `--<repo>` flags. Any field absent ⇒ fall back to env/default.
 */
export interface ScriptContext {
  /** `--dev` override: the sibling-repo workspace root. */
  dev?: string;
  /** Per-repo absolute-path pins, keyed by manifest `RepoKey` (env-var name). */
  repoRoots?: Partial<Record<RepoKey, string>>;
}

/**
 * Default checkout dir name under `<dev>` for each repo — mirrors up.sh's
 * `${VAR:-$DEV/<dir>}` defaults (~lines 173-180). Note `SDS` defaults to
 * `student-data-system`, NOT `sds`.
 */
export const REPO_DEFAULT_DIR: Record<RepoKey, string> = {
  SOA: 'soa',
  ROSTERING: 'rostering',
  PROGRAM_HUB: 'program-hub',
  SAGA_DASH: 'saga-dash',
  COACH: 'coach',
  SDS: 'student-data-system',
  QBOARD: 'qboard',
  RTSM: 'rtsm',
  FLEEK: 'fleek',
};

/** The sibling-repo workspace root: `--dev` → `$DEV` → `$HOME/dev`. */
export function resolveDevRoot(ctx: ScriptContext = {}): string {
  return ctx.dev ?? process.env.DEV ?? join(process.env.HOME ?? '', 'dev');
}

/**
 * A repo's checkout root: `--<repo>`/`repoRoots[repo]` → `$<REPO>` →
 * `<dev>/<defaultDir>`. (`process.env[repo]` works because the manifest
 * `RepoKey` literal IS the env-var name up.sh reads.)
 */
export function resolveRepoRoot(repo: RepoKey, ctx: ScriptContext = {}): string {
  return (
    ctx.repoRoots?.[repo] ??
    process.env[repo] ??
    join(resolveDevRoot(ctx), REPO_DEFAULT_DIR[repo])
  );
}

/** Absolute path to a located script (no existence guard). */
function scriptPath(locator: ScriptLocator, ctx: ScriptContext = {}): string {
  return join(resolveRepoRoot(locator.repo, ctx), locator.relPath);
}

/** The script's own directory — the cwd the bash script expects to run from. */
export function scriptCwd(locator: ScriptLocator, ctx: ScriptContext = {}): string {
  return dirname(scriptPath(locator, ctx));
}

/**
 * Absolute path to the located script. Throws (with the resolved repo root and
 * the precedence hint) if the file is absent, so the user gets a pointed error
 * before any spawn is attempted.
 */
export function resolveScript(locator: ScriptLocator, ctx: ScriptContext = {}): string {
  const path = scriptPath(locator, ctx);
  if (!existsSync(path)) {
    throw new Error(
      `saga-stack: could not find ${locator.relPath} at ${path}\n` +
        `  resolved ${locator.repo} root: ${resolveRepoRoot(locator.repo, ctx)}\n` +
        `  set --${locator.repo.toLowerCase().replace(/_/g, '-')} <path>, $${locator.repo}, ` +
        `or --dev/$DEV so the ${locator.repo} checkout is correct.`,
    );
  }
  return path;
}
