/**
 * Listener-provenance IO — the host side of `core/provenance`. Resolves where a
 * listening process is actually running from and when it started, and when each
 * checkout's HEAD last moved. Host/process IO lives ONLY here; `core/provenance`
 * stays pure.
 *
 * Listener resolution is DELEGATED to the existing `ForeignIo` (`pidOnPort` +
 * `procInfo`) rather than re-implemented, so both checks agree on what is
 * listening and the cross-platform `lsof`/`ss`/`ps` handling lives in one place.
 *
 * Cross-platform where it can be: `procInfo` and start time go through POSIX
 * `ps`; the cwd probe prefers Linux `/proc/<pid>/cwd` and falls back to
 * `lsof -d cwd` (macOS). Every probe folds errors into `null`, so the check
 * DEGRADES TO `unknown` — never to a false alarm.
 *
 * HEAD movement is read from the checkout's reflog file mtime
 * (`<gitdir>/logs/HEAD`), not from the HEAD commit's own date. The two differ in
 * the case that matters: fast-forwarding to a commit authored last week moves
 * your working tree TODAY, and a process started yesterday is stale even though
 * the commit predates it. `logs/HEAD` is touched exactly when HEAD moves
 * (checkout, pull, merge, reset) and — unlike `.git/index` — is not rewritten by
 * a plain `git status`, so it does not produce phantom staleness.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  classifyProvenance,
  type ProcOrigin,
  type ProvenanceRow,
} from '../core/provenance.js';
import { foreignCheckTargets, type PortListener } from '../core/foreign-procs.js';
import type { Manifest, ServiceId } from '../core/manifest/index.js';
import { makeRealForeignIo, type ForeignIo } from './foreign-procs.js';

/** Options for {@link Provenance.assess}. */
export interface AssessProvenanceOptions {
  manifest: Manifest;
  /** Service subset to check; omitted ⇒ every non-optional service. */
  services?: ServiceId[];
  /** A slot's offset ports (`InstanceProfile.portOverrides`); absent ⇒ base ports. */
  portOverrides?: Partial<Record<ServiceId, number>>;
  /** Service → the checkout `ss` resolves for its repo (`resolveRepoRoot`). */
  expectedRoots: Map<ServiceId, string>;
}

/** The command-facing seam. `stack status` calls `assess` (report-only). */
export interface Provenance {
  assess(opts: AssessProvenanceOptions): Promise<ProvenanceRow[]>;
}

/** The low-level host IO, injectable so `makeRealProvenance` is unit-testable. */
export interface ProvenanceIo {
  /** Where `pid` is running from + when it started; `null` if it has vanished. */
  procOrigin(pid: number): Promise<ProcOrigin | null>;
  /** When `root`'s HEAD last moved (ms), or `null` if unreadable. */
  refMovedAt(root: string): number | null;
  /** Canonical form of a path, for root-vs-root equality; input on any failure. */
  canonical(path: string): string;
}

/** Run a command, resolving its trimmed stdout (or '' on any error). NEVER throws. */
function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString());
    });
  });
}

/** Canonicalise, folding any failure back to the input so comparisons still run. */
function defaultCanonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The nearest ancestor of `from` (inclusive) that holds a `.git` entry — the
 * process's CHECKOUT. A linked worktree's `.git` is a FILE, not a directory, and
 * that is precisely the case this must catch, so presence is tested rather than
 * directory-ness. `null` when no ancestor qualifies.
 */
export function checkoutRootOf(from: string, exists: (p: string) => boolean = existsSync): string | null {
  let dir = from;
  for (;;) {
    if (exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolve a checkout's git dir, following the `gitdir:` pointer of a linked worktree. */
export function gitDirOf(root: string): string | null {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  try {
    const pointer = readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    const target = match?.[1]?.trim();
    if (!target) return null;
    return isAbsolute(target) ? target : resolve(root, target);
  } catch {
    return null;
  }
}

/**
 * The production `ProvenanceIo`. `procOrigin` reads `/proc/<pid>/cwd` (Linux),
 * falling back to `lsof -d cwd` (macOS), and takes the start time from POSIX
 * `ps -o lstart=`; `refMovedAt` stats the checkout's reflog.
 */
export function makeRealProvenanceIo(): ProvenanceIo {
  return {
    async procOrigin(pid: number): Promise<ProcOrigin | null> {
      let cwd: string | null = null;
      try {
        cwd = realpathSync(`/proc/${pid}/cwd`);
      } catch {
        // Not Linux, or not ours to read — try lsof's cwd descriptor.
        const out = await runCapture('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
        const line = out.split('\n').find((l) => l.startsWith('n'));
        cwd = line ? line.slice(1).trim() || null : null;
      }

      const lstart = (await runCapture('ps', ['-o', 'lstart=', '-p', String(pid)])).trim();
      const parsed = lstart ? Date.parse(lstart) : Number.NaN;
      const startedAtMs = Number.isNaN(parsed) ? null : parsed;

      // A pid with neither a cwd nor a start time has vanished between probes.
      if (cwd === null && startedAtMs === null) return null;

      return {
        pid,
        checkoutRoot: cwd === null ? null : checkoutRootOf(cwd),
        startedAtMs,
      };
    },

    refMovedAt(root: string): number | null {
      const gitDir = gitDirOf(root);
      if (gitDir === null) return null;
      // `logs/HEAD` is touched exactly when HEAD moves. Fall back to `HEAD`
      // itself when reflogs are disabled — it still changes on branch switches.
      for (const candidate of [join(gitDir, 'logs', 'HEAD'), join(gitDir, 'HEAD')]) {
        try {
          return statSync(candidate).mtimeMs;
        } catch {
          /* try the next candidate */
        }
      }
      return null;
    },

    canonical: defaultCanonical,
  };
}

/**
 * Build the command-facing seam over a `ProvenanceIo` + the shared `ForeignIo`
 * (production IO by default). Resolves each target port's listener, that
 * listener's origin, and each expected checkout's last HEAD movement, then runs
 * the pure `classifyProvenance`.
 *
 * Probes run CONCURRENTLY across services — `status` already probes health in
 * parallel, and a provenance pass that visibly slowed it down would get turned
 * off.
 */
export function makeRealProvenance(
  io: ProvenanceIo = makeRealProvenanceIo(),
  foreignIo: ForeignIo = makeRealForeignIo(),
): Provenance {
  return {
    async assess(opts: AssessProvenanceOptions): Promise<ProvenanceRow[]> {
      const targets = foreignCheckTargets(opts.manifest, opts.services, opts.portOverrides);

      const resolved = await Promise.all(
        targets.map(async ({ port }) => {
          const pid = await foreignIo.pidOnPort(port);
          if (pid === null) return null;
          const info = await foreignIo.procInfo(pid);
          if (info === null) return null; // vanished mid-probe ⇒ treat as down
          const origin = await io.procOrigin(pid);
          return {
            listener: { port, pid, pgid: info.pgid, command: info.command } satisfies PortListener,
            origin,
          };
        }),
      );

      const listeners = new Map<number, PortListener>();
      const origins = new Map<number, ProcOrigin>();
      for (const entry of resolved) {
        if (entry === null) continue;
        listeners.set(entry.listener.port, entry.listener);
        if (entry.origin !== null) origins.set(entry.listener.pid, entry.origin);
      }

      // Canonicalise expected roots so they compare equal to the realpath'd cwds.
      const expectedRoots = new Map<ServiceId, string>();
      for (const [id, root] of opts.expectedRoots) expectedRoots.set(id, io.canonical(root));

      const refMovedAt = new Map<string, number | null>();
      for (const root of new Set(expectedRoots.values())) {
        refMovedAt.set(root, io.refMovedAt(root));
      }

      return classifyProvenance(targets, listeners, origins, expectedRoots, refMovedAt);
    },
  };
}
