/**
 * postgres helpers — pg_dump / pg_restore via `docker exec saga-mesh-postgres`.
 *
 * Uses the container's built-in postgres client tools so the host doesn't
 * need them installed. All operations assume the saga-mesh-postgres
 * container (from ~/dev/soa/infra/compose/projects/saga-mesh.yml) is running —
 * callers should assert that via isContainerRunning() first and fail
 * fast with a clear message.
 *
 * Dump format: custom (-F c). Allows `pg_restore --clean --if-exists`
 * for idempotent restores. Binary, not line-oriented — don't assume
 * readability.
 */

import { spawn } from 'node:child_process';
import { openSync, closeSync, statSync, createReadStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const POSTGRES_CONTAINER = process.env.SAGA_MESH_POSTGRES_CONTAINER ?? 'saga-mesh-postgres';
export const REDIS_CONTAINER = process.env.SAGA_MESH_REDIS_CONTAINER ?? 'saga-mesh-redis';
export const POSTGRES_ADMIN_USER = process.env.SAGA_MESH_POSTGRES_ADMIN_USER ?? 'postgres_admin';

// The six databases saga-mesh hosts, per ~/dev/soa/infra/compose/projects/saga-mesh/seed/profile-empty.sql.
// Keep this list in sync with that SQL and with phase-2/port-assignments.md.
export const SAGA_MESH_DATABASES = [
  'iam_local',
  'iam_pii_local',
  'programs',
  'scheduling',
  'ads_adm_local',
  'ledger_local',
] as const;
export type SagaMeshDatabase = (typeof SAGA_MESH_DATABASES)[number];

interface SpawnResult {
  exitCode: number | null;
  stderr: string;
}

function runDockerSpawn(args: string[], options: { stdout?: 'inherit' | { toFile: string }; stdin?: string } = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdoutTarget: 'inherit' | number = 'inherit';
    if (options.stdout && typeof options.stdout === 'object' && 'toFile' in options.stdout) {
      stdoutTarget = openSync(options.stdout.toFile, 'w');
    }

    const proc = spawn('docker', args, {
      stdio: [options.stdin ? 'pipe' : 'ignore', stdoutTarget, 'pipe'],
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (options.stdin && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    proc.on('error', (err) => {
      if (typeof stdoutTarget === 'number') closeSync(stdoutTarget);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (typeof stdoutTarget === 'number') closeSync(stdoutTarget);
      resolve({ exitCode: code, stderr });
    });
  });
}

export async function isContainerRunning(container: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['ps', '--filter', `name=^${container}$`, '--format', '{{.Names}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.on('exit', () => resolve(stdout.trim() === container));
    proc.on('error', () => resolve(false));
  });
}

/**
 * pg_dump `db` from `saga-mesh-postgres` → `outPath`. Uses custom format
 * (-F c) so pg_restore can selectively drop and reload.
 */
export async function pgDump(db: SagaMeshDatabase, outPath: string): Promise<void> {
  // Preserve ownership — per-app users (iam / iam_pii / saga_user / ads_adm /
  // ledger) exist in every saga-mesh instance because profile-empty.sql
  // creates them. Without OWNER TO directives, restored tables end up owned
  // by postgres_admin and the app-level users lose access (→ permission
  // denied on SELECT).
  const { exitCode, stderr } = await runDockerSpawn(
    [
      'exec',
      POSTGRES_CONTAINER,
      'pg_dump',
      '-U',
      POSTGRES_ADMIN_USER,
      '-d',
      db,
      '-F',
      'c',
    ],
    { stdout: { toFile: outPath } },
  );
  if (exitCode !== 0) {
    throw new Error(
      `pg_dump ${db} → ${outPath} failed (exit=${exitCode}). stderr:\n${stderr}`,
    );
  }
}

/**
 * pg_restore `dumpPath` → `db` on `saga-mesh-postgres`. Uses --clean
 * --if-exists so existing objects are dropped and recreated. Input is
 * read via stdin so we don't need a shared volume between host and
 * container.
 */
export async function pgRestore(db: SagaMeshDatabase, dumpPath: string): Promise<void> {
  // Stream the dump file into `docker exec -i saga-mesh-postgres pg_restore
  // -d <db> --clean --if-exists`. --clean + --if-exists make pg_restore drop
  // existing objects first (idempotent against a non-empty DB), which is
  // what we want for restore-over-setup flows.
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'docker',
      [
        'exec',
        '-i',
        POSTGRES_CONTAINER,
        'pg_restore',
        '-U',
        POSTGRES_ADMIN_USER,
        '-d',
        db,
        '--clean',
        '--if-exists',
      ],
      { stdio: ['pipe', 'inherit', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    const src = createReadStream(dumpPath);
    src.on('error', reject);
    src.pipe(proc.stdin);

    proc.on('error', reject);
    proc.on('exit', (code) => {
      // pg_restore returns non-zero on warnings too (e.g. "some dropped
      // objects didn't exist"). Distinguish real errors by scanning stderr
      // for ERROR: or FATAL:. Print other stderr (warnings) and continue.
      if (code !== 0 && /^\s*(ERROR|FATAL):/m.test(stderr)) {
        reject(new Error(`pg_restore ${db} failed (exit=${code}). stderr:\n${stderr}`));
      } else {
        if (stderr) process.stderr.write(stderr);
        resolve();
      }
    });
  });
}

/**
 * redis-cli FLUSHDB on saga-mesh-redis. Called after a restore so
 * rostering's Redis cache (see PR #82) doesn't serve stale data from
 * before the restore.
 */
export async function redisFlushdb(): Promise<void> {
  const { exitCode, stderr } = await runDockerSpawn(
    ['exec', REDIS_CONTAINER, 'redis-cli', 'FLUSHDB'],
    { stdout: 'inherit' },
  );
  if (exitCode !== 0) {
    throw new Error(`redis-cli FLUSHDB failed (exit=${exitCode}). stderr:\n${stderr}`);
  }
}

/** Convenience: make sure a directory exists (mkdir -p). */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Get file size in bytes (0 if missing). */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Convenience: join a snapshot dir with a db's dump filename. */
export function dumpPathFor(snapshotDir: string, db: SagaMeshDatabase): string {
  return join(snapshotDir, `${db}.dump`);
}
