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
 * soa#359 — KEY RECONCILE: scaffolding only fires when the `.env` is ABSENT, so an EXISTING
 * `.env`/`.env.local` that predates a template gaining a new required var goes silently stale —
 * the break behind "iam-api never became healthy" (rostering's `.env.local` lacked
 * `AUTHZ_DATABASE_URL`, so authz-db's `prisma generate` threw and the whole rostering build
 * died). So for a PRESENT `.env`, this ALSO reports the `.env.example` keys missing from the
 * repo's `ENV_KEY_SOURCES` (`missingExampleKeys`) as an action item. It REPORTS, never appends:
 * a template's value can be wrong for a given box (e.g. a port that differs from the local mesh).
 *
 * Discovery is a PRUNED recursive walk (skips `node_modules`/`.git`/build output — the noise that
 * would otherwise surface a dependency's own `.env.example`); the copy is `.env.example` → `.env`.
 * The pure helpers (`classifyEnv`, `shouldPrune`, `parseEnvKeys`) are unit-tested; the walk, copy,
 * and read live behind the injectable `EnvFs` seam. IO stays in `src/runtime/**`.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EnsureRepo } from './ensure-repos.js';

/** The template filename a repo ships and the runtime file it seeds. */
export const ENV_EXAMPLE = '.env.example';
export const ENV_TARGET = '.env';

/**
 * The env files a repo's dotenv chain actually reads (besides the vars the CLI injects).
 * A key declared in `.env.example` counts as "provided" if it appears in ANY of these —
 * `.env.local` overrides `.env` in dotenv precedence, so either satisfies the key. This
 * is the union heuristic behind the soa#359 reconcile check (`missingExampleKeys`); it
 * can't model a tool that reads ONLY `.env.local`, but it never false-flags a key that
 * a checkout does provide somewhere.
 */
export const ENV_KEY_SOURCES = ['.env', '.env.local'] as const;

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

/**
 * PURE: the variable names assigned in a dotenv-style file — one `KEY=value` per line,
 * `#` comments and blank lines ignored, an optional `export ` prefix allowed. Values are
 * irrelevant to the reconcile check, so they're discarded. `null`/empty ⇒ no keys.
 */
export function parseEnvKeys(content: string | null): string[] {
  if (!content) return [];
  const keys: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const name = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (name) keys.push(name);
  }
  return keys;
}

/** One `.env` outcome (for the command's report + JSON). */
export interface EnvEnsureResult {
  /** The repo dir name. */
  repo: string;
  /** The `.env` path, repo-relative (e.g. `apps/node/iam-api/.env`). */
  relPath: string;
  action: EnvAction;
  /**
   * Keys declared in this dir's `.env.example` but absent from every `ENV_KEY_SOURCES`
   * file (soa#359). Non-empty ⇒ an existing `.env`/`.env.local` predates a template that
   * added a required var — the silent break behind "iam-api never became healthy".
   */
  missingKeys: string[];
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
  /** Read a file's text, or `null` if missing/unreadable (for the key-reconcile check). */
  read(path: string): string | null;
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

      // soa#359: only a PRE-EXISTING env can be stale — a fresh scaffold is a verbatim
      // copy of the template, so it has every example key by construction.
      const missingKeys = action === 'present' ? missingExampleKeys(dir, example, fs) : [];
      const relPath = relative(repo.path, target);
      results.push({
        repo: repo.name,
        relPath,
        action,
        missingKeys,
        message: envMessage(action, relPath, deps.dryRun ?? false, missingKeys),
      });
      notify(
        `  ${envSymbol(action, missingKeys)} ${repo.name}/${relPath}` +
          (action === 'scaffolded' && deps.dryRun ? ' (would copy)' : '') +
          (missingKeys.length > 0 ? ` — missing key(s): ${missingKeys.join(', ')}` : ''),
      );
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

/**
 * soa#359: the `.env.example` keys in `dir` that no `ENV_KEY_SOURCES` file provides.
 * Reads the template plus each present `.env`/`.env.local` through the `EnvFs.read` seam
 * and returns example keys missing from their union. An example with no parseable keys
 * (or an unreadable one) yields `[]` — a warning, never an invented key.
 */
function missingExampleKeys(dir: string, example: string, fs: EnvFs): string[] {
  const exampleKeys = parseEnvKeys(fs.read(example));
  if (exampleKeys.length === 0) return [];
  const have = new Set<string>();
  for (const name of ENV_KEY_SOURCES) {
    const p = join(dir, name);
    if (fs.exists(p)) for (const k of parseEnvKeys(fs.read(p))) have.add(k);
  }
  return exampleKeys.filter((k) => !have.has(k));
}

/** The human line for one env outcome. */
function envMessage(action: EnvAction, relPath: string, dryRun: boolean, missingKeys: string[]): string {
  switch (action) {
    case 'present':
      return missingKeys.length > 0
        ? `${relPath} present but MISSING key(s) from ${ENV_EXAMPLE}: ${missingKeys.join(', ')} — add them (set your own values)`
        : `${relPath} present`;
    case 'scaffolded':
      return dryRun
        ? `${relPath} MISSING — would copy from ${ENV_EXAMPLE} (review the values)`
        : `${relPath} scaffolded from ${ENV_EXAMPLE} — REVIEW the values`;
    case 'missing-no-template':
      return `${relPath} MISSING and no ${ENV_EXAMPLE} to copy — create it by hand`;
  }
}

/** The status glyph for an env action (a present file MISSING template keys warns). */
function envSymbol(action: EnvAction, missingKeys: string[]): string {
  if (action === 'present' && missingKeys.length > 0) return '⚠';
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
    read(path: string): string | null {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}
