/**
 * #260 — repair the `node_modules` corruption a plain reprep can't fix.
 *
 * soa#256's freshness stamp TRIGGERS a reprep after a pull/ff, but the reprep's
 * `pnpm install` is a no-op when pnpm considers `node_modules` already consistent with
 * the lockfile — even when it is CORRUPT. The known case (program-hub#335): a pnpm
 * `.bin` shim left pointing at a `.pnpm/<pkg>@<ver>` store path that a version bump
 * deleted (a stale `.bin/tsc` → `typescript@5.9.3` after a TS 5→6 bump). pnpm sees
 * lockfile==store and won't regenerate the shim, so the build fails on every `up`;
 * neither `pnpm install` nor `--force` cures it — only wiping `node_modules` does.
 *
 * This module detects that signature cheaply — a `.bin` entry (dangling symlink OR a
 * shell shim) referencing a `.pnpm/<pkg>@<ver>` dir that no longer exists — and, when
 * found, wipes EVERY `node_modules` under the repo (root + workspace packages;
 * `.worktrees` excluded, mirroring the confirmed manual fix) so the follow-up reinstall
 * relinks clean. Detection is the gate prep uses so a GENUINE compile error never
 * triggers a (useless, minutes-long) wipe.
 *
 * INVARIANT: process/fs IO lives in `src/runtime/**`; these run only on a build failure.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/** Dirs we never descend into while locating `.bin` shims / `node_modules` to wipe. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', '.worktrees', 'dist', '.turbo', '.next']);

/** A `.pnpm` store-path segment: `<pkg>@<ver>` (the dir under `node_modules/.pnpm/`). */
const PNPM_SEG_RE = /[/\\]\.pnpm[/\\]([^/\\\s"':]+)/g;

/**
 * Every `node_modules` dir under a repo — the root's plus each workspace package's —
 * with `.worktrees` (sibling worktree checkouts) and other build/vcs dirs excluded.
 * Walks the SOURCE tree only: a found `node_modules` is recorded but never descended
 * into, so the huge virtual store is not traversed.
 */
export function nodeModulesDirs(repoRoot: string): string[] {
  const out: string[] = [];
  const stack = [repoRoot.replace(/\/+$/, '')];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir ⇒ skip
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') {
        out.push(join(dir, 'node_modules')); // record, do NOT descend
      } else if (!SKIP_DIRS.has(e.name)) {
        stack.push(join(dir, e.name));
      }
    }
  }
  return out;
}

/** True iff a single `.bin` entry references a `.pnpm/<pkg>@<ver>` dir that is gone. */
function binEntryIsStale(entryPath: string, pnpmRoot: string): boolean {
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(entryPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    // A dangling symlink (its `.pnpm` target is gone) ⇒ existsSync (which follows it) is false.
    return !existsSync(entryPath);
  }
  // A pnpm shell shim: it embeds the store as an absolute `.../.pnpm/<seg>/...` path.
  let text: string;
  try {
    text = readFileSync(entryPath, 'utf8');
  } catch {
    return false;
  }
  for (const m of text.matchAll(PNPM_SEG_RE)) {
    const seg = m[1];
    if (seg && !existsSync(join(pnpmRoot, seg))) return true;
  }
  return false;
}

/**
 * Does any `.bin` shim in the repo reference a `.pnpm/<pkg>@<ver>` dir that no longer
 * exists? That is the corruption class a plain `pnpm install` won't self-heal. Returns
 * on the FIRST hit (cheap); false when everything resolves (⇒ a real build failure).
 */
export function hasStaleBinShim(repoRoot: string): boolean {
  const pnpmRoot = join(repoRoot.replace(/\/+$/, ''), 'node_modules', '.pnpm');
  for (const nm of nodeModulesDirs(repoRoot)) {
    const binDir = join(nm, '.bin');
    let names: string[];
    try {
      names = readdirSync(binDir);
    } catch {
      continue; // no `.bin` here
    }
    for (const name of names) {
      if (binEntryIsStale(join(binDir, name), pnpmRoot)) return true;
    }
  }
  return false;
}

/**
 * Remove EVERY `node_modules` under the repo (root + workspace packages), `.worktrees`
 * excluded — the confirmed cure for the stale-shim corruption (a root-only wipe leaves
 * per-package `.bin` shims in place). Best-effort: an unremovable dir is skipped, never
 * an abort. Longest-path-first so a parent removal can't orphan a child mid-walk.
 */
export function wipeNodeModules(repoRoot: string): void {
  for (const nm of nodeModulesDirs(repoRoot).sort((a, b) => b.length - a.length)) {
    try {
      rmSync(nm, { recursive: true, force: true });
    } catch {
      // best-effort — a dir we can't remove just means the reinstall relinks around it.
    }
  }
}

/**
 * The #260 prep repair seam: if a build failure carries the stale-shim signature, wipe
 * the repo's `node_modules` and return true so prep reinstalls + rebuilds once. Returns
 * false when there is nothing repairable (⇒ prep applies its normal fatal/non-fatal
 * build handling). This is the ONLY place a real repair `rm -rf` runs.
 */
export function repairStaleDeps(repoRoot: string): boolean {
  if (!hasStaleBinShim(repoRoot)) return false;
  wipeNodeModules(repoRoot);
  return true;
}
