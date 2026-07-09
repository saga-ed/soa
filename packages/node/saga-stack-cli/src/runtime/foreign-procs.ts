/**
 * Foreign-process IO — the host side of `core/foreign-procs`. Resolves which pid
 * listens on each stack port, reads the slot's `ss` pidfiles, and reaps a foreign
 * process group. Host/process IO lives ONLY here; `core/foreign-procs` stays pure.
 *
 * Cross-platform by design: port→pid + pid→pgid go through `lsof`/`ss`/`ps` (all
 * present on a Linux OR macOS dev box) — `/proc` is NOT required. Every shell-out
 * folds errors into a safe answer (a missing `lsof`/`ss` ⇒ "nothing found"), so
 * the guardrail DEGRADES OPEN: worst case it reports no foreign process rather
 * than a false positive. All IO is behind the injectable `ForeignIo` so tests
 * assert the wiring with no sockets, no `ps`, and no `kill`.
 */

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyForeign,
  foreignCheckTargets,
  type ForeignProc,
  type PortListener,
} from '../core/foreign-procs.js';
import type { Manifest, ServiceId } from '../core/manifest/index.js';

/** A foreign process after a reap attempt. */
export interface ReapedProc extends ForeignProc {
  /** True once the pid is confirmed gone (signal delivered or already dead). */
  killed: boolean;
}

/** Options for {@link ForeignProcs.find}. */
export interface FindForeignOptions {
  manifest: Manifest;
  /** Service subset to check; omitted ⇒ every non-optional service. */
  services?: ServiceId[];
  /** The slot's pidfile dir (`<stateDir>/<id>.pid`) — the ownership source. */
  stateDir: string;
  /** A slot's offset ports (`InstanceProfile.portOverrides`); absent ⇒ base ports. */
  portOverrides?: Partial<Record<ServiceId, number>>;
}

/**
 * The command-facing seam: find foreign processes on stack ports, and reap them.
 * `stack verify` calls `find` (warn-only); `stack cold-start` calls `find` then
 * `reap`. Injected via `BaseCommand.getForeignProcs()` so command tests fake it.
 */
export interface ForeignProcs {
  find(opts: FindForeignOptions): Promise<ForeignProc[]>;
  reap(foreign: ForeignProc[]): Promise<ReapedProc[]>;
}

/**
 * The low-level host IO, injectable so `makeRealForeignProcs` is unit-testable.
 * A real impl shells out (`lsof`/`ss`/`ps`) + touches the fs + signals; a fake
 * answers from maps.
 */
export interface ForeignIo {
  /** The first LISTENING pid on host `port`, or null if nothing listens. */
  pidOnPort(port: number): Promise<number | null>;
  /** The pgid + short command for `pid`, or null if it has already vanished. */
  procInfo(pid: number): Promise<{ pgid: number; command: string } | null>;
  /** The pids recorded in `<stateDir>/*.pid` (== ss pgid leaders); [] if none. */
  ownedPgids(stateDir: string): number[];
  /** SIGKILL a process group (negative pid), then confirm the pid is gone. */
  killGroup(pgid: number, pid: number): boolean;
}

/** Run a command, resolving its trimmed stdout (or '' on any error). NEVER throws. */
function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString());
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM ⇒ alive but not ours to signal; anything else (ESRCH) ⇒ gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The production `ForeignIo`. `pidOnPort` prefers `lsof -t` (terse pid list,
 * works on Linux + macOS), falling back to `ss -ltnHp` for a Linux box without
 * lsof; `procInfo` uses POSIX `ps -o pgid=,args=`; `killGroup` SIGKILLs the
 * negative pid (the whole detached tree) with a bare-pid fallback.
 */
export function makeRealForeignIo(): ForeignIo {
  return {
    async pidOnPort(port: number): Promise<number | null> {
      // lsof -t: newline-separated pids that hold the port; a process with both
      // an IPv4 and IPv6 listener shows twice, so take the first.
      const lsof = await runCapture('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
      const fromLsof = lsof.split('\n').map((s) => Number.parseInt(s.trim(), 10)).find(Number.isInteger);
      if (fromLsof !== undefined) return fromLsof;
      // Fallback (Linux, no lsof): ss prints `users:(("node",pid=1234,fd=27))`.
      const ss = await runCapture('ss', ['-ltnHp', `sport = :${port}`]);
      const matched = ss.match(/pid=(\d+)/)?.[1];
      return matched ? Number.parseInt(matched, 10) : null;
    },

    async procInfo(pid: number): Promise<{ pgid: number; command: string } | null> {
      // POSIX `ps -o pgid=,args=` → "  <pgid> <full command…>"; headers suppressed
      // by the trailing `=`. `args` (not `comm`) so the label carries dist/main.js.
      const out = (await runCapture('ps', ['-o', 'pgid=,args=', '-p', String(pid)])).trim();
      if (!out) return null;
      const sp = out.indexOf(' ');
      if (sp < 0) return null;
      const pgid = Number.parseInt(out.slice(0, sp).trim(), 10);
      const command = out.slice(sp + 1).trim();
      if (!Number.isInteger(pgid)) return null;
      return { pgid, command };
    },

    ownedPgids(stateDir: string): number[] {
      let files: string[];
      try {
        files = readdirSync(stateDir);
      } catch {
        return []; // no state dir yet ⇒ ss has launched nothing here
      }
      const pids: number[] = [];
      for (const file of files) {
        if (!file.endsWith('.pid')) continue;
        try {
          const pid = Number.parseInt(readFileSync(join(stateDir, file), 'utf8').trim(), 10);
          if (Number.isInteger(pid) && pid > 0) pids.push(pid);
        } catch {
          /* unreadable/stale pidfile ⇒ skip */
        }
      }
      return pids;
    },

    killGroup(pgid: number, pid: number): boolean {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone — treat as reaped below */
        }
      }
      return !pidAlive(pid);
    },
  };
}

/**
 * Build the command-facing seam over a `ForeignIo` (production IO by default).
 * `find` resolves each target port's listener + the slot's owned pgids and runs
 * the pure `classifyForeign`; `reap` group-kills each foreign pgid and reports
 * which are confirmed gone.
 */
export function makeRealForeignProcs(io: ForeignIo = makeRealForeignIo()): ForeignProcs {
  return {
    async find(opts: FindForeignOptions): Promise<ForeignProc[]> {
      const targets = foreignCheckTargets(opts.manifest, opts.services, opts.portOverrides);
      const listeners = new Map<number, PortListener>();
      for (const { port } of targets) {
        const pid = await io.pidOnPort(port);
        if (pid === null) continue;
        const info = await io.procInfo(pid);
        if (info === null) continue; // vanished between the two probes ⇒ treat as down
        listeners.set(port, { port, pid, pgid: info.pgid, command: info.command });
      }
      const ownedPgids = new Set(io.ownedPgids(opts.stateDir));
      return classifyForeign(targets, listeners, ownedPgids);
    },

    async reap(foreign: ForeignProc[]): Promise<ReapedProc[]> {
      // Group-kill each foreign process. When two services share one supervisor
      // pgid, the second SIGKILL to the now-dead group is a harmless ESRCH no-op
      // (folded inside killGroup), and `killed` is still checked per-pid — so no
      // dedupe is needed and every finding reports its own liveness accurately.
      return foreign.map((f) => ({ ...f, killed: io.killGroup(f.pgid, f.pid) }));
    },
  };
}
