/**
 * `env-ensure` — make sure every repo that ships a `.env.example` has a sibling `.env` before a
 * cold start (soa#cold-start).
 *
 * The CLI injects the env vars IT knows over each spawned service's `process.env`, but any var it
 * does NOT inject is expected to come from that repo's OWN dotenv chain (e.g. `$ROSTERING/.env`,
 * `apps/node/iam-api/.env`). On a FRESH clone those files don't exist yet, and the intended source
 * is the committed `.env.example` next to each. So a cold start's env step is: find every
 * `.env.example` in the required repos and, where the sibling `.env` is MISSING, copy the example
 * across (a scaffold). Existing `.env` files are NEVER overwritten — a developer's real values win.
 *
 * This is honest about its limits: it copies the TEMPLATE (whose values are the synthetic-dev
 * defaults the team commits), it does not invent secrets. A repo that needs a `.env` but ships no
 * example is reported as `missing-no-template` — an action item, not a silent pass.
 *
 * Discovery is a PRUNED recursive walk (skips `node_modules`/`.git`/build output — the noise that
 * would otherwise surface a dependency's own `.env.example`); the copy is `.env.example` → `.env`.
 * The action classifier (`classifyEnv`) + the prune predicate (`shouldPrune`) are PURE and
 * unit-tested; the walk + copy live behind the injectable `EnvFs` seam. IO stays in
 * `src/runtime/**`.
 */

import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EnsureRepo } from './ensure-repos.js';

/** The template filename a repo ships and the runtime file it seeds. */
export const ENV_EXAMPLE = '.env.example';
export const ENV_TARGET = '.env';

/** Dir names the discovery walk NEVER descends into (noise / not source). */
export const ENV_WALK_PRUNE = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.worktrees',
  'dist',
  'build',
  '.svelte-kit',
  '.next',
  '.turbo',
]);

/** PURE: should the walk prune (skip) a dir with this base name? */
export function shouldPrune(dirName: string): boolean {
  return ENV_WALK_PRUNE.has(dirName);
}

/** What ensuring one `.env` did (or found). */
export type EnvAction =
  | 'present' // `.env` already exists — untouched
  | 'scaffolded' // `.env` was missing; copied from `.env.example`
  | 'missing-no-template'; // `.env` missing AND no `.env.example` to copy (reported, not fixed)

/** PURE: classify the action for one location from what exists there. */
export function classifyEnv(input: { exampleExists: boolean; targetExists: boolean }): EnvAction {
  if (input.targetExists) return 'present';
  return input.exampleExists ? 'scaffolded' : 'missing-no-template';
}

/** One `.env` outcome (for the command's report + JSON). */
export interface EnvEnsureResult {
  /** The repo dir name. */
  repo: string;
  /** The `.env` path, repo-relative (e.g. `apps/node/iam-api/.env`). */
  relPath: string;
  action: EnvAction;
  /** A ready-to-print human line. */
  message: string;
}

/** The injectable env-fs seam (discovery walk + copy). */
export interface EnvFs {
  /** List a dir's entries with their kind. `[]` on any error. */
  list(dir: string): { name: string; isDir: boolean }[];
  exists(path: string): boolean;
  /** Copy `.env.example` → `.env` (never called when the target exists). */
  copy(from: string, to: string): void;
}

/** The seams + inputs `ensureEnv` drives. */
export interface EnsureEnvDeps {
  fs: EnvFs;
  /** `.git` presence predicate — default `EnvFs.exists`. A missing checkout is skipped. */
  notify?: (msg: string) => void;
  /** Don't copy — just report what WOULD happen (cold start `--dry-run`). */
  dryRun?: boolean;
}

/** The outcome of a whole cold-start env pass. */
export interface EnsureEnvResult {
  /** True iff nothing is left `missing-no-template` (a scaffold is a fix, not a failure). */
  ok: boolean;
  results: EnvEnsureResult[];
}

/**
 * Walk each required repo for `.env.example` templates and ensure a sibling `.env`, copying the
 * template where the `.env` is missing (unless `dryRun`). Never throws — a missing checkout is
 * skipped, an unreadable dir yields no templates. Returns the full per-file table for the report.
 */
export function ensureEnv(repos: EnsureRepo[], deps: EnsureEnvDeps): EnsureEnvResult {
  const { fs } = deps;
  const notify = deps.notify ?? ((): void => {});

  const results: EnvEnsureResult[] = [];
  for (const repo of repos) {
    if (!fs.exists(join(repo.path, '.git'))) continue; // not cloned — ensure-repos owns that

    const exampleDirs = discoverTemplateDirs(repo.path, fs);
    for (const dir of exampleDirs) {
      const target = join(dir, ENV_TARGET);
      const example = join(dir, ENV_EXAMPLE);
      const action = classifyEnv({ exampleExists: true, targetExists: fs.exists(target) });
      if (action === 'scaffolded' && !deps.dryRun) fs.copy(example, target);

      const relPath = relative(repo.path, target);
      results.push({
        repo: repo.name,
        relPath,
        action,
        message: envMessage(action, relPath, deps.dryRun ?? false),
      });
      notify(`  ${envSymbol(action)} ${repo.name}/${relPath}${action === 'scaffolded' && deps.dryRun ? ' (would copy)' : ''}`);
    }
  }
  return { ok: results.every((r) => r.action !== 'missing-no-template'), results };
}

/**
 * Discover the dirs under `repoRoot` that contain a `.env.example` (a pruned recursive walk —
 * see `ENV_WALK_PRUNE`). Returns absolute dir paths. Uses only the `EnvFs.list` seam so it's
 * driven by a fake in tests.
 */
function discoverTemplateDirs(repoRoot: string, fs: EnvFs): string[] {
  const found: string[] = [];
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = fs.list(dir);
    let hasExample = false;
    for (const e of entries) {
      if (e.isDir) {
        if (!shouldPrune(e.name)) stack.push(join(dir, e.name));
      } else if (e.name === ENV_EXAMPLE) {
        hasExample = true;
      }
    }
    if (hasExample) found.push(dir);
  }
  // Stable order (deep-first stack yields reverse) — sort for a deterministic report.
  return found.sort();
}

/** The human line for one env outcome. */
function envMessage(action: EnvAction, relPath: string, dryRun: boolean): string {
  switch (action) {
    case 'present':
      return `${relPath} present`;
    case 'scaffolded':
      return dryRun
        ? `${relPath} MISSING — would copy from ${ENV_EXAMPLE} (review the values)`
        : `${relPath} scaffolded from ${ENV_EXAMPLE} — REVIEW the values`;
    case 'missing-no-template':
      return `${relPath} MISSING and no ${ENV_EXAMPLE} to copy — create it by hand`;
  }
}

/** The status glyph for an env action. */
function envSymbol(action: EnvAction): string {
  switch (action) {
    case 'present':
      return '·';
    case 'scaffolded':
      return '✓';
    case 'missing-no-template':
      return '⚠';
  }
}

/** The production env-fs seam — the only place the discovery walk + `.env` copy touch the disk. */
export function makeRealEnvFs(): EnvFs {
  return {
    list(dir: string): { name: string; isDir: boolean }[] {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((d) => ({
          name: d.name,
          isDir: d.isDirectory(),
        }));
      } catch {
        return [];
      }
    },
    exists(path: string): boolean {
      return existsSync(path);
    },
    copy(from: string, to: string): void {
      // The template's dir always exists (it holds `from`), so a plain copy suffices; "never
      // overwrite" is enforced by the caller (copy is only invoked for a MISSING target).
      copyFileSync(from, to);
    },
  };
}
