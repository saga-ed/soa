/**
 * Slot claims (advisory "who last drove this slot" state): `<stateDir>/claim.json`.
 *
 * A claim is written on entry by every command that DRIVES a slot's stack and
 * records the resolved actor (SS_ACTOR > claude-ancestry > user@host:tty), the
 * exact command line, and each repo's source posture at launch. It is ADVISORY —
 * the deliberate counterpart to slot-active.ts's "no recorded active state"
 * stance: activity stays DERIVED LIVE (nothing to go stale), while identity is
 * RECORDED history (staleness is judged at READ time by pid liveness, because
 * the stack outlives its driver by design). Nothing ever deletes claim.json —
 * a stale claim on an inactive slot is normal "last driven by" history.
 *
 * Everything folds: the writer NEVER throws (a claim must never break a
 * bring-up), the reader answers `null` on missing/garbage/wrong-shape files.
 *
 * DEDUP DEBT: `defaultPidAlive` is the third copy of the signal-0 EPERM=alive
 * helper (lock.ts + slot-active.ts keep module-private twins) — worth a shared
 * home if a fourth caller appears.
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { hostname as osHostname, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SetRepoKey } from '../core/set/worktree-sets.js';
import { hasTrackedChanges, makeRealGitRunner } from './git.js';
import type { GitRunner } from './git.js';
import { resolveHeadSha } from './prep-stamp.js';

/** The claim file name under a slot's state dir. */
export const CLAIM_FILE = 'claim.json';

/** One repo's source posture captured at launch time (drift baseline). */
export interface ClaimRepoSource {
  branch: string;
  headSha: string;
  dirty: boolean;
}

/** The advisory claim body — `<stateDir>/claim.json`. */
export interface SlotClaim {
  version: 1;
  /** Resolved identity, e.g. "coach-aug3-training" | "claude:41234" | "skelly@host:pts/4". */
  actor: string;
  actorSource: 'env' | 'claude' | 'fallback';
  /** The `ss` process pid — claim staleness = pid liveness at READ time. */
  pid: number;
  /** e.g. "ss stack:up --slot 2 --only iam-api". */
  command: string;
  /** ISO-8601. */
  at: string;
  cwd: string;
  slot: number;
  /** Worktree-set name when the invocation was --set-driven. */
  set?: string;
  sourceAtLaunch: Partial<Record<SetRepoKey, ClaimRepoSource>>;
}

/** What a claiming command hands the writer. */
export interface ClaimWriteInput {
  slot: number;
  stateDir: string;
  command: string;
  set?: string;
  /** Absolute paths; the writer SKIPS roots that don't exist on disk. */
  repoRoots: Partial<Record<SetRepoKey, string>>;
}

/** Injectable deps (seam style: slot-active.ts SlotActiveDeps / lock.ts PrepLockOptions). */
export interface ClaimDeps {
  /** Default `process.env` (actor resolution reads SS_ACTOR). */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock (the timestamp is informational). */
  now?: () => string;
  /** The `ss` process pid — both the claim body and the ancestry-walk start. */
  pid?: number;
  cwd?: () => string;
  /** Branch + dirty probes only; default the real runner. */
  git?: GitRunner;
  /** HEAD sha per repo root; default prep-stamp's ZERO-SPAWN resolveHeadSha. */
  headShaOf?: (repoRoot: string) => string;
  dirExists?: (p: string) => boolean;
  /** Default: recursive-mkdir the parent, then writeFileSync. */
  writeFile?: (path: string, data: string) => void;
  /** Default: readFileSync folded to `null`. */
  readFile?: (path: string) => string | null;
  /** Liveness: signal-0 the pid (EPERM counts as alive). */
  pidAlive?: (pid: number) => boolean;
  /** Raw `/proc/<pid>/stat` folded to `null` (ancestry-walk ppid source). */
  readProcStat?: (pid: number) => string | null;
  /** Raw `/proc/<pid>/cmdline` folded to `null` (`\0`-separated). */
  readProcCmdline?: (pid: number) => string | null;
  /** Default node:os userInfo().username folded to 'unknown'. */
  username?: () => string;
  /** Default node:os hostname() folded to ''. */
  hostname?: () => string;
  /** Default readlink /proc/self/fd/2 → e.g. 'pts/4'; `null` off-tty/error. */
  ttyName?: () => string | null;
}

/** The resolved actor identity + which rung of the ladder produced it. */
export interface ResolvedActor {
  actor: string;
  actorSource: SlotClaim['actorSource'];
}

/** The advisory writer — NEVER throws; all errors fold to a silent no-op. */
export interface ClaimWriter {
  write(input: ClaimWriteInput): Promise<void>;
}

/** What a read yields: the claim + whether its writer pid is still alive. */
export interface ClaimReadResult {
  claim: SlotClaim;
  live: boolean;
}

/** Sync reader — `null` on missing/unparseable/shape-invalid claim files. */
export interface ClaimReader {
  read(stateDir: string): ClaimReadResult | null;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultReadProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
}

function defaultReadProcCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return null;
  }
}

function defaultUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function defaultHostname(): string {
  try {
    return osHostname();
  } catch {
    return '';
  }
}

function defaultTtyName(): string | null {
  try {
    const link = readlinkSync('/proc/self/fd/2');
    // Only real terminal nodes count — /dev/null (`2>/dev/null`) and other
    // /dev non-terminals must fold to null, not render as "user@host:null".
    const name = link.startsWith('/dev/') ? link.slice('/dev/'.length) : null;
    return name !== null && /^(pts\/|tty)/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function defaultWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, 'utf8');
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse the ppid out of a raw `/proc/<pid>/stat` blob. The `comm` field is
 * parenthesised and may itself contain spaces/`)`, so split AFTER the last `)`:
 * the remaining fields are `state ppid pgrp …` (same trick as lock.ts's
 * module-private readProcState, which returns pgid not ppid — hence new code).
 */
function ppidFromStat(raw: string | null): number | null {
  if (raw === null) return null;
  const rp = raw.lastIndexOf(')');
  if (rp < 0) return null;
  const rest = raw.slice(rp + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** True iff any `\0`-separated cmdline token's basename is exactly `claude`. */
function cmdlineIsClaude(cmdline: string): boolean {
  return cmdline.split('\0').some((token) => token !== '' && basename(token) === 'claude');
}

/**
 * Resolve the actor identity, in order:
 * 1. non-empty `SS_ACTOR` (an agent declares itself) → `actorSource: 'env'`;
 * 2. a `claude` process anywhere up the ppid chain (max 25 hops, cycle-safe,
 *    stops at pid ≤ 1 or an unreadable /proc entry) → `claude:<pid>`;
 * 3. fallback `<username>@<hostname>[:<tty>]`.
 */
export function resolveActor(deps: ClaimDeps = {}): ResolvedActor {
  const env = deps.env ?? process.env;
  const fromEnv = (env.SS_ACTOR ?? '').trim();
  if (fromEnv !== '') return { actor: fromEnv, actorSource: 'env' };

  const readProcStat = deps.readProcStat ?? defaultReadProcStat;
  const readProcCmdline = deps.readProcCmdline ?? defaultReadProcCmdline;
  const seen = new Set<number>();
  let pid: number | null = deps.pid ?? process.pid;
  for (let hop = 0; hop < 25 && pid !== null && pid > 1 && !seen.has(pid); hop++) {
    seen.add(pid);
    const cmdline = readProcCmdline(pid);
    if (cmdline !== null && cmdlineIsClaude(cmdline)) {
      return { actor: `claude:${pid}`, actorSource: 'claude' };
    }
    pid = ppidFromStat(readProcStat(pid));
  }

  const username = (deps.username ?? defaultUsername)();
  const host = (deps.hostname ?? defaultHostname)();
  const tty = (deps.ttyName ?? defaultTtyName)();
  return {
    actor: `${username}@${host}${tty !== null ? `:${tty}` : ''}`,
    actorSource: 'fallback',
  };
}

/**
 * Build the advisory claim writer. `write` never throws: a per-repo probe
 * failure drops just that repo from `sourceAtLaunch`; any other failure
 * (unwritable state dir, a throwing seam) folds to a silent no-op.
 */
export function makeClaimWriter(deps: ClaimDeps = {}): ClaimWriter {
  const now = deps.now ?? (() => new Date().toISOString());
  const pid = deps.pid ?? process.pid;
  const cwd = deps.cwd ?? process.cwd;
  const git = deps.git ?? makeRealGitRunner();
  const headShaOf = deps.headShaOf ?? resolveHeadSha;
  const dirExists = deps.dirExists ?? existsSync;
  const writeFile = deps.writeFile ?? defaultWriteFile;

  return {
    async write(input: ClaimWriteInput): Promise<void> {
      try {
        const { actor, actorSource } = resolveActor(deps);

        const sourceAtLaunch: Partial<Record<SetRepoKey, ClaimRepoSource>> = {};
        const roots = Object.entries(input.repoRoots) as [SetRepoKey, string][];
        await Promise.all(
          roots.map(async ([repo, root]) => {
            try {
              if (!dirExists(root)) return;
              const [branch, porcelain] = await Promise.all([
                git.branchShowCurrent(root),
                git.statusPorcelain(root),
              ]);
              sourceAtLaunch[repo] = {
                branch,
                headSha: headShaOf(root),
                dirty: hasTrackedChanges(porcelain),
              };
            } catch {
              // A broken repo probe costs only its own entry, never the claim.
            }
          }),
        );

        const claim: SlotClaim = {
          version: 1,
          actor,
          actorSource,
          pid,
          command: input.command,
          at: now(),
          cwd: cwd(),
          slot: input.slot,
          set: input.set,
          sourceAtLaunch,
        };
        writeFile(join(input.stateDir, CLAIM_FILE), `${JSON.stringify(claim, null, 2)}\n`);
      } catch {
        // Advisory: a claim must never break the command that writes it.
      }
    },
  };
}

/** Minimal shape gate — enough to trust the fields the CLI renders. */
function isSlotClaim(value: unknown): value is SlotClaim {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.version === 1 &&
    typeof c.actor === 'string' &&
    (c.actorSource === 'env' || c.actorSource === 'claude' || c.actorSource === 'fallback') &&
    // pid must be a real positive integer — `process.kill(0|-1, 0)` signals the
    // reader's own group/everything and always "succeeds" (slot-active's guard).
    typeof c.pid === 'number' &&
    Number.isInteger(c.pid) &&
    c.pid > 0 &&
    typeof c.command === 'string' &&
    typeof c.at === 'string' &&
    typeof c.cwd === 'string' &&
    typeof c.slot === 'number' &&
    (c.set === undefined || typeof c.set === 'string') &&
    typeof c.sourceAtLaunch === 'object' &&
    c.sourceAtLaunch !== null
  );
}

/** Build the sync reader; `live` is judged fresh on every read (pid liveness). */
export function makeClaimReader(deps: ClaimDeps = {}): ClaimReader {
  const readFile = deps.readFile ?? defaultReadFile;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;

  return {
    read(stateDir: string): ClaimReadResult | null {
      const raw = readFile(join(stateDir, CLAIM_FILE));
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!isSlotClaim(parsed)) return null;
      return { claim: parsed, live: pidAlive(parsed.pid) };
    },
  };
}
