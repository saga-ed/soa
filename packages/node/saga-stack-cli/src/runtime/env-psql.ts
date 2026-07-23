/**
 * psql shell-out seam for the `ss env org` commands (soa#355).
 *
 * Runs read/write SQL against a (usually SSM-port-forwarded) Postgres via the
 * `psql` binary — no driver dependency, same stance as `env-aws.ts`. Rows come
 * back as unit-separator-delimited fields (`-F $'\x1f'`), so values containing
 * commas/tabs survive; `-X -A -t` strips rc files, alignment, and headers;
 * `ON_ERROR_STOP=1` makes SQL errors exit non-zero instead of half-succeeding.
 *
 * INVARIANT: IO lives only in `src/runtime/**`; commands reach this through
 * `BaseCommand.getEnvPsql()`. Tests fake the interface — `makeRealEnvPsql()`
 * is the only spawn site.
 */

import { spawn } from 'node:child_process';

const FIELD_SEP = '\u001f';

export interface EnvPsql {
  /**
   * Run one SQL statement; resolve rows as arrays of string fields (empty
   * array for zero rows). Throws with psql's stderr on non-zero exit.
   */
  query(connString: string, sql: string): Promise<string[][]>;
}

/** psql argv for one query (exported for byte-level tests). */
export function psqlArgs(connString: string, sql: string): string[] {
  return ['-X', '-A', '-t', '-F', FIELD_SEP, '-v', 'ON_ERROR_STOP=1', connString, '-c', sql];
}

/**
 * Docker image used when `psql` is not on PATH: `docker run --network host`
 * makes 127.0.0.1 tunnel ports reachable, so the same connection string works.
 * The synthetic-dev hosts always carry a postgres image; a host with neither
 * psql nor docker gets a clear ENOENT.
 */
const DOCKER_PSQL_IMAGE = 'postgres:18-alpine';

export function makeRealEnvPsql(): EnvPsql {
  let useDocker = false;
  const run = (connString: string, sql: string): Promise<string[][]> =>
    new Promise((resolve, reject) => {
      const args = psqlArgs(connString, sql);
      const [cmd, argv] = useDocker
        ? (['docker', ['run', '--rm', '--network', 'host', DOCKER_PSQL_IMAGE, 'psql', ...args]] as const)
        : (['psql', args] as const);
      const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      // A failed spawn fires BOTH 'error' and 'close' — the flag keeps the
      // close handler from rejecting a promise the fallback retry now owns.
      let handedToFallback = false;
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('error', (err) => {
        // psql not installed → one-time switch to the docker fallback.
        if (!useDocker && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          useDocker = true;
          handedToFallback = true;
          run(connString, sql).then(resolve, reject);
          return;
        }
        reject(err);
      });
      child.on('close', (code) => {
        if (handedToFallback) return;
        if (code !== 0) {
          reject(new Error(`psql exited ${code}: ${stderr.trim()}`));
          return;
        }
        const rows = stdout
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => line.split(FIELD_SEP));
        resolve(rows);
      });
    });
  return { query: run };
}
