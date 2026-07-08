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
 * pid dead) is reaped and retaken once.
 *
 * ABANDONED (STOPPED) HOLDER (soa#266 follow-up): a `kill(pid, 0)` liveness
 * probe treats a *stopped* (STAT=T, e.g. a Ctrl-Z'd / suspended `ss stack up`)
 * holder as alive, so its lock never reaped and wedged every future bring-up
 * indefinitely. We now detect a stopped holder (it can never make progress) and,
 * when the caller's `reclaimStopped` policy says so (`--yes` auto, or an
 * interactive prompt), SIGKILL its process group and retake the lock. A
 * genuinely RUNNING holder is never touched — that is a real concurrent build.
 * Fresh-skipped repos never acquire (prep is a no-op there — sharing pre-built
 * checkouts stays legal).
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrepRepoLock } from './prep.js';

/** What the lock file records about its holder (also the error-message body). */
export interface LockHolder {
  pid: number;
  slot: number;
  root: string;
  at: string;
}

/** A live holder's process state, as read from the OS (Linux `/proc/<pid>/stat`). */
export interface ProcState {
  /** The single-char Linux state code — `T`/`t` mean stopped (not progressing). */
  state: string;
  /** The holder's process-group id, so an abandoned tree is killed as a group. */
  pgid: number;
}

/** Tunables + test seams for {@link makeRealPrepLock}. */
export interface PrepLockOptions {
  /** Injectable clock (the timestamp is informational). */
  now?: () => string;
  /**
   * Decide what to do about a held lock whose holder is STOPPED/abandoned. Return
   * true to KILL the holder's process group and reclaim; false/absent ⇒ fail fast
   * with a STOPPED-tagged who-holds-it message. Only ever called for a *stopped*
   * holder — a running holder is never offered for reclaim.
   */
  reclaimStopped?: (holder: LockHolder) => boolean | Promise<boolean>;
  /** Read a live pid's process state (default: Linux `/proc`); null ⇒ unknown/dead. */
  procState?: (pid: number) => ProcState | null;
  /** Kill an abandoned holder's process group (default: SIGKILL the pgid, then the pid). */
  killGroup?: (pgid: number, pid: number) => void;
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
 * Read a pid's state + process-group from Linux `/proc/<pid>/stat`. The `comm`
 * field is parenthesised and may itself contain spaces/`)`, so we split AFTER the
 * last `)`: the remaining fields are `state ppid pgrp …`. Returns null off-Linux
 * or if the pid vanished (⇒ caller treats as unknown, not stopped).
 */
function readProcState(pid: number): ProcState | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = raw.lastIndexOf(')');
    if (rp < 0) return null;
    const rest = raw.slice(rp + 2).trim().split(/\s+/);
    const state = rest[0];
    const pgid = Number(rest[2]);
    if (!state) return null;
    return { state, pgid: Number.isFinite(pgid) ? pgid : pid };
  } catch {
    return null;
  }
}

/** `T` (stopped) / `t` (traced-stop) ⇒ suspended, can never make build progress. */
function isStopped(state: ProcState | null): state is ProcState {
  return state !== null && (state.state === 'T' || state.state === 't');
}

/** SIGKILL the whole process group (an abandoned `ss` tree), falling back to the bare pid. */
function killProcGroup(pgid: number, pid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone — nothing to reap */
    }
  }
}

/**
 * Build the production lock. `slot` is recorded for the who-holds-it message.
 * `opts.now` is injectable only for tests; `opts.procState`/`opts.killGroup` are
 * test seams for the abandoned-holder path.
 */
export function makeRealPrepLock(slot: number, opts: PrepLockOptions = {}): PrepRepoLock {
  const now = opts.now ?? (() => new Date().toISOString());
  const procState = opts.procState ?? readProcState;
  const killGroup = opts.killGroup ?? killProcGroup;

  return {
    async acquire(repoRoot: string) {
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
            const state = procState(holder.pid);
            const stopped = isStopped(state);
            // An abandoned (stopped) holder can never finish. Offer it for reclaim;
            // on approval, kill its group and retake. A running holder is left alone.
            if (stopped && opts.reclaimStopped && (await opts.reclaimStopped(holder))) {
              killGroup(state.pgid, holder.pid);
              rmSync(path, { force: true });
              continue;
            }
            const base =
              `pid ${holder.pid} (slot ${holder.slot}) has been building ${holder.root} since ${holder.at} — ` +
              `lock ${path}`;
            return {
              ok: false as const,
              holder: stopped
                ? `${base} — the holder is STOPPED/abandoned and will never finish; ` +
                  `re-run with --yes to kill it and reclaim, or \`kill -9 -${state.pgid}\``
                : base,
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
