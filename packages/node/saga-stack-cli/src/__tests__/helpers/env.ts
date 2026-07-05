/**
 * Shared process.env test scaffolding (M15-C test-harness consolidation).
 *
 * `useTempSnapshotsDir` is the ONE place that guarantees the snapshot root a
 * test writes to is a throwaway temp dir. The hazard is real (the M13 lesson):
 * the snapshot/checkpoint stores resolve their root from
 * `$SAGA_MESH_SNAPSHOTS_DIR` and fall back to the REAL `~/.saga-mesh` under
 * $HOME — a test that forgets to point the env var at a temp dir will read
 * (or restore from!) the developer's actual snapshots, and one once WROTE
 * there. Every suite that touches the snapshot root goes through this helper
 * so the mkdtemp + env-set + rm/delete teardown can never drift out of sync.
 *
 * Per-test fresh dir: the helper registers its own vitest beforeEach/afterEach
 * (matching how the suites used the inline pattern), so each test gets a brand
 * new empty root and teardown always removes it and unsets the env var.
 *
 * `saveEnv`/`restoreEnv` capture the exact save-and-restore shape the suites
 * used inline (up-native's SLOT_ENV_KEYS block, slot-guard's single key): a
 * key that was UNSET at save time is deleted at restore time, not set to
 * the string 'undefined'.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/**
 * Point `$SAGA_MESH_SNAPSHOTS_DIR` at a fresh mkdtemp root for EVERY test in
 * the calling file (call at the top level, outside describe). Returns a getter
 * for the current test's dir — only valid while a test is running.
 */
export function useTempSnapshotsDir(prefix: string): () => string {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
    process.env.SAGA_MESH_SNAPSHOTS_DIR = dir;
  });

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.SAGA_MESH_SNAPSHOTS_DIR;
  });

  return () => {
    if (dir === undefined) {
      throw new Error('useTempSnapshotsDir: no active test — the temp dir only exists inside a test');
    }
    return dir;
  };
}

/** Opaque snapshot of a set of env keys' values (undefined = key was unset). */
export type EnvSnapshot = ReadonlyMap<string, string | undefined>;

/** Capture the current values of `keys` so `restoreEnv` can put them back. */
export function saveEnv(keys: readonly string[]): EnvSnapshot {
  const values = new Map<string, string | undefined>();
  for (const k of keys) values.set(k, process.env[k]);
  return values;
}

/** Restore a `saveEnv` snapshot: unset keys are deleted, set keys re-assigned. */
export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [k, v] of snapshot) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
