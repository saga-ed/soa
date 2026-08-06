/**
 * The `ss stack hydrate` execution seam.
 *
 * `stack hydrate` restores a LOCAL synthetic slot's Postgres from the daily prod
 * MIRROR. That means it introduces the first DATABASE-LEVEL destructive SQL in
 * this package (`DROP DATABASE … WITH (FORCE)`, `pg_terminate_backend`,
 * `ALTER DATABASE … RENAME`) and the first pipeline that carries a real
 * credential. Both go behind this ONE injectable seam, with every argv and every
 * statement produced by the pure planner in `core/mirror/plan.ts` — so the tests
 * assert what would run without a database, a container, or an AWS call
 * anywhere.
 *
 * The seam is deliberately DUMB: `exec(argv)` spawns `docker` with exactly the
 * argv it was handed. It makes no decisions, builds no strings, and knows
 * nothing about postgres. Everything interesting is upstream in the planner.
 *
 * CREDENTIAL CONTRACT — the reason `secret` is a separate parameter rather than
 * part of `argv`: the mirror's master password must never reach a file, a log,
 * or argv. `ps` shows any process's argv to every user on the box;
 * `/proc/<pid>/environ` is readable only by the same user. So the password is
 * injected into the CHILD's environment as `PGPASSWORD` and the planner emits a
 * bare `-e PGPASSWORD` (no `=value`) for `docker run`, which makes docker copy
 * it out of our environment instead of putting it on the command line. It is
 * also never echoed: `exec` returns stdout/stderr to the caller, and the command
 * layer prints argv, never env.
 *
 * NOTE on why this is not `EnvPsql`: that seam puts a whole
 * `postgres://user:pw@host/db` connection string in argv (`psqlArgs`), which is
 * fine for `trust`-auth local dev and fatal for a real master password.
 *
 * INVARIANT: process/docker IO lives ONLY in `src/runtime/**`; `src/core/**`
 * never imports this and stays pure.
 */

import { spawn } from 'node:child_process';
import { FIELD_SEP } from '../core/mirror/index.js';
import type { RealTableInfo } from '../core/mirror/index.js';

export interface HydrateExecResult {
  /** `null` when the child was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HydrateIO {
  /**
   * Spawn `docker <argv>` and capture both streams. `secret`, when present, is
   * exported to the CHILD ONLY as `PGPASSWORD` — never logged, never in argv.
   * Resolves with the exit code (it does NOT throw on non-zero): the caller
   * classifies, because `pg_restore` exits non-zero on benign warnings.
   */
  exec(argv: string[], opts?: { secret?: string }): Promise<HydrateExecResult>;

  /**
   * Fail fast with an actionable message when the slot's postgres container
   * isn't up, rather than mid-transfer with a cryptic docker error.
   */
  assertPgRunning(container: string): Promise<void>;
}

/**
 * Parse the mirror-side `_real` discovery read into per-table column lists.
 * PURE (exported for tests): rows arrive as `base<US>column`, ordered by table
 * then `attnum`, so grouping preserves the real table's column ORDER — which is
 * what makes the scrubbed-mode `COPY` column-exact instead of trusting that the
 * scramble view presents its columns in the same order.
 */
export function parseRealTableRows(stdout: string): RealTableInfo[] {
  const byTable = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [table, column] = line.split(FIELD_SEP);
    if (table === undefined || column === undefined) continue;
    const cols = byTable.get(table);
    if (cols === undefined) byTable.set(table, [column]);
    else cols.push(column);
  }
  return [...byTable.entries()].map(([table, columns]) => ({ table, columns }));
}

/** True iff a container of EXACTLY this name is running (docker ps name filter). */
async function isContainerRunning(container: string): Promise<boolean> {
  try {
    const { stdout } = await runDocker(['ps', '--filter', `name=^${container}$`, '--format', '{{.Names}}']);
    return stdout.trim() === container;
  } catch {
    return false;
  }
}

/** The single real `docker` spawn site for the hydrate lane. */
function runDocker(argv: string[], secret?: string): Promise<HydrateExecResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Child-env only. `delete` (rather than leaving a stale value) so a step
    // that must NOT carry the credential provably does not.
    if (secret === undefined) delete env.PGPASSWORD;
    else env.PGPASSWORD = secret;
    const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject); // ENOENT (docker not installed) surfaces directly
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export function makeRealHydrateIO(): HydrateIO {
  return {
    exec(argv, opts): Promise<HydrateExecResult> {
      return runDocker(argv, opts?.secret);
    },

    async assertPgRunning(container): Promise<void> {
      if (!(await isContainerRunning(container))) {
        throw new Error(
          `slot postgres container '${container}' is not running.\n` +
            '  Bring the slot up first (e.g. `ss stack up --slot <N>`), then retry the hydrate.',
        );
      }
    },
  };
}
