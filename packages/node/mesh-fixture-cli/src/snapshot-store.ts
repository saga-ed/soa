/**
 * Snapshot on-disk store — shared helpers for the snapshot-storage layer.
 *
 * Shape under $SAGA_MESH_SNAPSHOTS_DIR (default ~/.saga-mesh/snapshots):
 *
 *   <id>/
 *     manifest.json          # SnapshotManifest JSON
 *     iam_local.dump         # pg_dump -F c output, one per saga-mesh DB
 *     iam_pii_local.dump
 *     ...
 *
 * Kept out of src/commands/ so oclif's pattern-strategy command loader
 * doesn't try to treat it as a command.
 */

import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SagaMeshDatabase } from './lib/postgres.js';
import {
  isContainerRunning,
  POSTGRES_CONTAINER,
  REDIS_CONTAINER,
} from './lib/postgres.js';

export const SNAPSHOTS_ROOT =
  process.env.SAGA_MESH_SNAPSHOTS_DIR ?? join(homedir(), '.saga-mesh', 'snapshots');

export interface SnapshotManifest {
  /** Fixture identifier (= directory name under SNAPSHOTS_ROOT). */
  fixtureId: string;
  /** Human description (optional, --description flag). */
  description?: string;
  /** ISO timestamp of the store operation. */
  createdAt: string;
  /** saga-mesh-postgres container name at the time of store. */
  container: string;
  /** SEED_PROFILE at store time (makes cross-profile restores fail-loud). */
  seedProfile?: string;
  /** Per-database dump metadata. */
  databases: Array<{
    name: SagaMeshDatabase;
    dumpFile: string;
    sizeBytes: number;
  }>;
  /** Tool version that wrote this manifest. */
  cliVersion: string;
}

export interface SnapshotEntry {
  fixtureId: string;
  path: string;
  sizeBytes: number;
  mtime: Date;
  manifest: SnapshotManifest | null;
}

export function snapshotDir(fixtureId: string): string {
  return join(SNAPSHOTS_ROOT, fixtureId);
}

export function readManifest(dir: string): SnapshotManifest | null {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SnapshotManifest;
  } catch {
    return null;
  }
}

export function scanSnapshots(): SnapshotEntry[] {
  if (!existsSync(SNAPSHOTS_ROOT)) return [];
  const entries: SnapshotEntry[] = [];
  for (const name of readdirSync(SNAPSHOTS_ROOT)) {
    const path = join(SNAPSHOTS_ROOT, name);
    const st = statSync(path);
    if (!st.isDirectory()) continue;
    let sizeBytes = 0;
    try {
      for (const child of readdirSync(path)) {
        sizeBytes += statSync(join(path, child)).size;
      }
    } catch {
      // ignore
    }
    entries.push({
      fixtureId: name,
      path,
      sizeBytes,
      mtime: st.mtime,
      manifest: readManifest(path),
    });
  }
  return entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export async function assertPostgresRunning(): Promise<void> {
  if (!(await isContainerRunning(POSTGRES_CONTAINER))) {
    throw new Error(
      `saga-mesh postgres container '${POSTGRES_CONTAINER}' is not running.\n` +
        `  Bring it up: (cd ~/dev/soa/infra && make up PROJECT=saga-mesh PROFILE=empty)`,
    );
  }
}

export async function assertRedisRunning(): Promise<void> {
  if (!(await isContainerRunning(REDIS_CONTAINER))) {
    throw new Error(
      `saga-mesh redis container '${REDIS_CONTAINER}' is not running.\n` +
        `  Bring it up: (cd ~/dev/soa/infra && make up PROJECT=saga-mesh PROFILE=empty)`,
    );
  }
}
