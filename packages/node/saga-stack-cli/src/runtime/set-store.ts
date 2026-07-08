/**
 * Worktree-set store — the thin IO half of M13-A (plan §1.2). Reads
 * `$SAGA_STACK_SETS ?? ~/.saga-stack/worktree-sets.json`, re-validating on
 * EVERY read (hand-editing the JSON is fully supported), and normalizes each
 * entry's path for use as a repo root:
 *
 *   - a missing file is NOT an error — it parses to the empty store, the same
 *     tolerance `runtime/flows.ts` gives a missing flows.json;
 *   - `~`/`~/…` expands to the caller's home dir;
 *   - a relative path (discouraged, plan §1.2) resolves against the sets
 *     file's own directory;
 *   - malformed JSON / schema violations throw the pure layer's pointed
 *     errors (plus a JSON.parse wrapper naming the file).
 *
 * The store is consumed through the `BaseCommand.getSetStore()` seam so
 * command tests substitute a canned store without touching the fs — mirroring
 * `getRunner`/`getGitRunner`/`getSnapshotIO`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { emptyWorktreeSetsFile, parseWorktreeSetsFile, serializeWorktreeSetsFile } from '../core/set/index.js';
import type { SetRepoKey, WorktreeSetsFile } from '../core/set/index.js';

/** A `process.env`-shaped lookup, injectable for tests. */
type EnvLookup = Record<string, string | undefined>;

/** The injectable store: one read, re-validated + path-normalized. */
export interface SetStore {
  /** Absolute path of the sets file this store reads (for error/help text). */
  path(): string;
  /** Parse the sets file; a missing file yields the empty store. */
  load(): WorktreeSetsFile;
  /**
   * Parse the sets file WITHOUT `~`/relative path expansion (M13-C mutation path). The
   * `set create`/`rm` verbs load-raw → mutate → `save`, so other sets' hand-authored `~`
   * paths survive the round-trip verbatim instead of being rewritten to absolute.
   */
  loadRaw(): WorktreeSetsFile;
  /**
   * Write the file back as pretty JSON, creating the parent dir. Round-trip VALIDATED
   * (re-parses the serialized form) so a malformed set is never persisted.
   */
  save(file: WorktreeSetsFile): void;
}

/** `$SAGA_STACK_SETS` override, else `~/.saga-stack/worktree-sets.json`. */
export function setsFilePath(env: EnvLookup = process.env, home: string = homedir()): string {
  const override = env.SAGA_STACK_SETS;
  return override !== undefined && override !== '' ? override : join(home, '.saga-stack', 'worktree-sets.json');
}

/** Expand `~`/`~/…` to `home`; resolve a relative path against `baseDir`. */
export function normalizeSetPath(path: string, home: string, baseDir: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/** The production store (real fs + env + homedir). */
export function makeRealSetStore(env: EnvLookup = process.env, home: string = homedir()): SetStore {
  const file = setsFilePath(env, home);
  return {
    path: () => file,
    load(): WorktreeSetsFile {
      if (!existsSync(file)) return emptyWorktreeSetsFile();

      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`worktree-sets: ${file} is not valid JSON: ${(err as Error).message}`);
      }

      const parsed = parseWorktreeSetsFile(data);
      const baseDir = dirname(file);
      for (const set of Object.values(parsed.sets)) {
        for (const repo of Object.keys(set.repos) as SetRepoKey[]) {
          const entry = set.repos[repo];
          if (entry !== undefined) entry.path = normalizeSetPath(entry.path, home, baseDir);
        }
      }
      return parsed;
    },
    loadRaw(): WorktreeSetsFile {
      if (!existsSync(file)) return emptyWorktreeSetsFile();
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`worktree-sets: ${file} is not valid JSON: ${(err as Error).message}`);
      }
      return parseWorktreeSetsFile(data); // no path normalization — verbatim, for round-trip
    },
    save(next: WorktreeSetsFile): void {
      // Round-trip validate: a set that would fail a future load (bad slot, dup, etc.)
      // must never reach disk.
      const onDisk = serializeWorktreeSetsFile(next);
      parseWorktreeSetsFile(onDisk);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`);
    },
  };
}
