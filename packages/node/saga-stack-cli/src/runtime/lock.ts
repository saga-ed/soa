/**
 * Realpath-keyed prep lock (M13-B, plan §4 layer 2). The race-proof backstop
 * under the up-front collision check: before R1 prep BUILDS a repo checkout,
 * take an exclusive lock keyed on the checkout's realpath, so two `ss`
 * invocations (any mix of slots/sets/plain `up`s) can never `pnpm install`/
 * `build` one tree concurrently.
 *
 * Mechanism: `O_EXCL`-create `/tmp/saga-stack-prep-<sha1(realpath)>.lock`
 * holding `{pid, slot, root, at}`. Held ⇒ FAIL FAST with who-holds-it (never
 * silently wait — the caller surfaces a pointed error). A stale lock (holder
 * pid dead) is reaped and retaken once. Fresh-skipped repos never acquire
 * (prep is a no-op there — sharing pre-built checkouts stays legal).
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrepRepoLock } from './prep.js';

/** What the lock file records about its holder (also the error-message body). */
interface LockHolder {
  pid: number;
  slot: number;
  root: string;
  at: string;
}

/** The lock file path for a repo root — realpath-keyed so worktree aliases collide. */
export function prepLockPath(repoRoot: string): string {
  let real: string;
  try {
    real = realpathSync(repoRoot);
  } catch {
    real = repoRoot;
  }
  const key = createHash('sha1').update(real).digest('hex').slice(0, 16);
  return join(tmpdir(), `saga-stack-prep-${key}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Build the production lock. `slot` is recorded for the who-holds-it message.
 * `now` is injectable only for tests (the timestamp is informational).
 */
export function makeRealPrepLock(slot: number, now: () => string = () => new Date().toISOString()): PrepRepoLock {
  return {
    acquire(repoRoot: string) {
      const path = prepLockPath(repoRoot);
      const body: LockHolder = { pid: process.pid, slot, root: repoRoot, at: now() };

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          writeFileSync(path, JSON.stringify(body), { flag: 'wx' });
          return { ok: true as const, release: () => rmSync(path, { force: true }) };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            // Un-creatable lock dir/file: fail open (never block prep on lock IO).
            return { ok: true as const, release: () => {} };
          }
          let holder: LockHolder | null = null;
          try {
            holder = JSON.parse(readFileSync(path, 'utf8')) as LockHolder;
          } catch {
            holder = null;
          }
          if (holder !== null && pidAlive(holder.pid)) {
            return {
              ok: false as const,
              holder:
                `pid ${holder.pid} (slot ${holder.slot}) has been building ${holder.root} since ${holder.at} — ` +
                `lock ${path}`,
            };
          }
          // Stale (holder dead or unreadable): reap and retry ONCE.
          rmSync(path, { force: true });
        }
      }
      return { ok: false as const, holder: `lock ${path} could not be acquired (still contended after stale reap)` };
    },
  };
}
