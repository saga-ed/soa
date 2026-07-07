/**
 * Post-down orphan audit (saga-ed/soa#249 — the warning layer).
 *
 * `stack down` group-kills every pid recorded under the slot's state dir
 * (`stopServices(stateDir)` — SIGTERM→grace→SIGKILL of the whole process group).
 * That closes the launch-side hole, but the FAILURE MODE the issue documents —
 * a `tsup --watch` / vite watch child orphaned by an OLDER build (or a pidfile
 * lost to a crashed `up`) surviving teardown and silently serving a STALE build
 * on the slot's ports — is invisible unless someone goes looking. This audit
 * makes it loud: after the service stop, scan the slot's RESOLVED service-port
 * band for sockets still LISTENing and report each survivor with its pid, port,
 * and a ready-to-paste kill hint.
 *
 * The scan is an injectable seam (`OrphanScanner`) in the same family as the
 * preflight `PortProbe` (preflight.ts) — production shells out (`ss -lptnH`,
 * falling back to per-port `lsof`), tests inject a fake, and the command layer
 * never execs anything raw. Like the preflight probe, every branch folds errors
 * into a safe answer: a missing `ss`/`lsof` reports "no survivors" (degrades
 * open) rather than failing the teardown.
 *
 * INVARIANT (plan hard constraint): host/process IO lives only in
 * `src/runtime/**`; `src/core/**` never imports this and stays pure.
 */

import { execFile } from 'node:child_process';

/** A socket still LISTENing on an audited port after `down`. */
export interface OrphanListener {
  /** The audited (slot-resolved) port the survivor holds. */
  port: number;
  /** Owning pid, when the scanner could see it (own processes need no sudo). */
  pid?: number;
  /** Owning command name (e.g. `node`), when visible. */
  command?: string;
}

/**
 * The injectable post-down listener scan. `scan(ports)` answers which of the
 * given ports STILL have a LISTEN socket, with the holder's pid/command when
 * visible. Production wires `makeRealOrphanScanner()`; tests pass a fake.
 */
export interface OrphanScanner {
  scan(ports: number[]): Promise<OrphanListener[]>;
}

/**
 * Injectable low-level dep of the real scanner: run a command and capture its
 * stdout ('' on ANY failure — never throws). Overridden in unit tests to feed
 * canned `ss`/`lsof` output with no real exec.
 */
export type CaptureFn = (command: string, args: string[]) => Promise<string>;

/** Default capture: `execFile`, folding every error into '' (missing binary, non-zero exit). */
function defaultCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : (stdout ?? '').toString());
    });
  });
}

/**
 * `ss` candidates, most-trusted first. The BARE name comes LAST because this
 * very CLI ships a `ss` bin (saga-stack), and a pnpm-linked bin dir commonly
 * shadows iproute2's `ss` on exactly the dev machines this audit runs on — a
 * bare exec would hit the CLI, not the socket tool. An absolute candidate that
 * doesn't exist folds to '' (skipped); junk output (no parseable LISTEN row)
 * also advances the ladder.
 */
export const SS_CANDIDATES: readonly string[] = ['/usr/sbin/ss', '/usr/bin/ss', 'ss'];

/**
 * Parse one `ss -lptnH` row into `{ port, pid?, command? }`, or null when the
 * row isn't a LISTEN we can read. Row shape (no header):
 *   `LISTEN 0 511 *:4011 *:* users:(("node",pid=873122,fd=27))`
 * Column 3 is the local `addr:port`; the trailing process column is present
 * only for sockets whose owner we can inspect (own processes — no sudo needed,
 * which covers everything the launcher ever spawned). The LISTEN guard doubles
 * as the junk detector for a shadowed `ss` (see `SS_CANDIDATES`).
 */
export function parseSsRow(line: string): OrphanListener | null {
  const cols = line.trim().split(/\s+/);
  if (cols[0] !== 'LISTEN') return null;
  const local = cols[3];
  if (!local) return null;
  const portMatch = /[:.](\d+)$/.exec(local);
  if (!portMatch) return null;
  const port = Number.parseInt(portMatch[1] ?? '', 10);
  if (!Number.isInteger(port)) return null;
  const proc = /users:\(\("([^"]*)",pid=(\d+)/.exec(line);
  return {
    port,
    ...(proc ? { command: proc[1] ?? '', pid: Number.parseInt(proc[2] ?? '', 10) } : {}),
  };
}

/**
 * The production scanner. One `ss -lptnH` enumerates every LISTEN socket with
 * pid/command (own processes visible without sudo); rows are filtered to the
 * audited ports. When `ss` is unavailable/empty, degrade to per-port
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` (terse output: `p<pid>` / `c<cmd>`
 * lines). Both ladders fold failure into "no survivors" — the audit must never
 * make `down` itself fail.
 */
export function makeRealOrphanScanner(capture: CaptureFn = defaultCapture): OrphanScanner {
  return {
    async scan(ports: number[]): Promise<OrphanListener[]> {
      if (ports.length === 0) return [];
      const wanted = new Set(ports);

      for (const bin of SS_CANDIDATES) {
        const ss = await capture(bin, ['-lptnH']);
        if (!ss.trim()) continue; // binary absent / failed — next candidate.
        const rows = ss
          .split('\n')
          .map(parseSsRow)
          .filter((r): r is OrphanListener => r !== null);
        // Non-empty output with ZERO parseable LISTEN rows ⇒ junk (e.g. the
        // saga-stack CLI shadowing `ss` and printing usage) — next candidate,
        // NEVER "no survivors" off garbage.
        if (rows.length === 0) continue;
        const found = new Map<number, OrphanListener>();
        for (const row of rows) {
          if (!wanted.has(row.port)) continue;
          // Prefer a row that names the pid (ss lists v4+v6 rows for one socket).
          const prev = found.get(row.port);
          if (!prev || (prev.pid === undefined && row.pid !== undefined)) {
            found.set(row.port, row);
          }
        }
        return [...found.values()].sort((a, b) => a.port - b.port);
      }

      // lsof fallback (ss missing): -Fpc emits `p<pid>` then `c<command>` per process.
      const survivors: OrphanListener[] = [];
      for (const port of [...wanted].sort((a, b) => a - b)) {
        const out = await capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
        if (!out.trim()) continue;
        const pidMatch = /^p(\d+)$/m.exec(out);
        const cmdMatch = /^c(.+)$/m.exec(out);
        survivors.push({
          port,
          ...(pidMatch ? { pid: Number.parseInt(pidMatch[1] ?? '', 10) } : {}),
          ...(cmdMatch ? { command: cmdMatch[1] ?? '' } : {}),
        });
      }
      return survivors;
    },
  };
}
