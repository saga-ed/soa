/**
 * Resolver + spawn helper for the pgm-seed child-process binary.
 *
 * Mirrors the ADS_ADM_SEED_BIN pattern from ads/seed-attendance.ts for
 * binary resolution, but adds stdout-tee behavior so the parent can
 * extract child-emitted UUIDs (programId, etc.) for fixture-registry
 * artifact bookkeeping while still relaying stdout to the user's
 * terminal in real time.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_PGM_SEED_BIN = resolve(
  homedir(),
  'dev/program-hub/packages/node/pgm-seed/dist/bin/pgm-seed.js',
);

export function resolvePgmSeedBin(): string {
  return process.env['PGM_SEED_BIN'] ?? DEFAULT_PGM_SEED_BIN;
}

/**
 * Spawn pgm-seed with the given args, tee stdout/stderr to the parent's
 * streams, and return exit code plus captured stdout for registry
 * post-processing. Keeps the same user-visible streaming behavior as
 * stdio:inherit.
 */
export async function spawnPgmSeed(
  binPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [binPath, ...args], {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env },
    });
    let captured = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      captured += s;
      process.stdout.write(s);
    });
    child.on('exit', (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout: captured });
    });
    child.on('error', (err) => {
      process.stderr.write(`pgm-seed failed to start: ${err.message}\n`);
      resolvePromise({ exitCode: 1, stdout: captured });
    });
  });
}

/**
 * Parse the last UUID-looking token from the child's stdout. Human-text
 * output is `  <verb> <kind>/<name> → <uuid>` or `  ok     enroll program=<short>... …`.
 * --output-json emits a JSON blob with `programId`/`periodId`/etc. fields.
 *
 * Returns null when no candidate is found; caller can fall back to the
 * name-based artifact key.
 */
export function extractUuidFromStdout(stdout: string, key: string): string | null {
  // JSON-shaped output: look for "<key>": "<uuid>".
  const jsonMatch = new RegExp(`"${key}"\\s*:\\s*"([0-9a-f-]{36})"`).exec(stdout);
  if (jsonMatch?.[1]) return jsonMatch[1];
  // porcelain-shaped output: <key>=<uuid>
  const porcelainMatch = new RegExp(`(?:^|\\n)${key}=([0-9a-f-]{36})`).exec(stdout);
  if (porcelainMatch?.[1]) return porcelainMatch[1];
  // Human-shaped output: "→ <uuid>" — last uuid on any line.
  const humanMatch = /→\s+([0-9a-f-]{36})/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = humanMatch.exec(stdout)) !== null) {
    last = m[1] ?? null;
  }
  return last;
}
