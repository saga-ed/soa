/**
 * Stage-checkpoint store — the IO half of M14 (plan `11-e2e-stage-snapshots.md`
 * §1). Bundles the snapshot store/restore ceremonies behind ONE fake-able
 * surface the e2e orchestrator consumes (`ExecDeps.checkpoints`):
 *
 *   - `load` — read + zod-validate a checkpoint's manifest (null if absent);
 *   - `bake` — overwrite-store the given DBs + write the manifest with the
 *     M14 `flow` provenance block (deterministic fixtureIds ⇒ re-bakes
 *     replace; checkpoints are cheap disposable derivatives);
 *   - `restore` — the full restore ceremony: local-migration gather (the
 *     schema-ahead HARD guard, honoring `--set`-pinned repo roots via the
 *     caller's ScriptContext), `restorePlan`, per-DB restore-as-owner, redis
 *     flush. Throws a pointed Error on any guard failure.
 *
 * CALL-TIME ENV CONTRACT: `snapshotDir`/container resolvers read
 * `$SAGA_MESH_*` when invoked — the command constructs this store AFTER
 * `applyInstanceEnv(profile)`, so a `--slot`/`--set` run bakes and restores
 * in ITS slot's snapshot root against ITS slot's containers.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { manifest as defaultManifest } from '../core/manifest/index.js';
import type { DbId, Manifest } from '../core/manifest/index.js';
import {
  checkpointBehindFailures,
  restorePlan,
  storePlan,
  CURRENT_SNAPSHOT_SCHEMA_VERSION,
} from '../core/snapshot/index.js';
import type { SnapshotDbEntry, SnapshotFlowBlock, SnapshotManifest } from '../core/snapshot/index.js';
import type { SnapshotIO } from './snapshot.js';
import {
  deleteSnapshot,
  ensureSnapshotDir,
  fileSize,
  gatherLocalMigrations,
  mongoContainer,
  postgresContainer,
  readManifest,
  redisContainer,
  snapshotDir,
  writeManifest,
} from './snapshot-store.js';
import type { ScriptContext } from './scripts.js';

/** What a bake stores beyond the DB dumps. */
export interface BakeInput {
  fixtureId: string;
  /** The flow's effective seed profile (stamped as the manifest `profile`). */
  profile: string;
  /** The DBs to dump — the slot-filtered flow closure's set. */
  dbs: DbId[];
  /** The M14 provenance block `--from` validates. */
  flow: SnapshotFlowBlock;
}

/** The injectable checkpoint surface (`ExecDeps.checkpoints`). */
export interface CheckpointStore {
  /** Read a checkpoint's manifest; null when absent/corrupt (caller errors pointedly). */
  load(fixtureId: string): SnapshotManifest | null;
  /** Overwrite-store a stage checkpoint. */
  bake(input: BakeInput): Promise<void>;
  /** Restore a checkpoint (schema-ahead guard + per-DB restore + redis flush). Throws on guard failure. */
  restore(snapshot: SnapshotManifest, opts: { currentProfile?: string }): Promise<void>;
}

/** Build the production store. `ctx` feeds the schema-ahead guard's migration discovery. */
export function makeCheckpointStore(deps: {
  io: SnapshotIO;
  ctx: ScriptContext;
  manifest?: Manifest;
}): CheckpointStore {
  const m = deps.manifest ?? defaultManifest;

  return {
    load(fixtureId: string): SnapshotManifest | null {
      return readManifest(snapshotDir(fixtureId));
    },

    async bake(input: BakeInput): Promise<void> {
      const plan = storePlan(m, { fixtureId: input.fixtureId, profile: input.profile, only: input.dbs });
      const pgC = postgresContainer();
      const mongoC = mongoContainer();

      await deps.io.assertPgRunning(pgC);
      if (plan.databases.some((d) => d.engine === 'mongo')) {
        await deps.io.assertMongoRunning(mongoC);
      }

      // Deterministic fixtureId ⇒ a re-bake REPLACES (no --force ceremony).
      const dir = snapshotDir(input.fixtureId);
      if (existsSync(dir)) deleteSnapshot(input.fixtureId);
      ensureSnapshotDir(dir);

      const databases: SnapshotDbEntry[] = [];
      for (const action of plan.databases) {
        const outPath = join(dir, action.file);
        if (action.engine === 'mongo') {
          await deps.io.mongoDump(mongoC, action.db, outPath);
        } else {
          await deps.io.pgDump(action.db, pgC, action.ownerRole, outPath);
        }
        const schemaRev = action.captureSchemaRev ? await deps.io.readSchemaRev(action.db, pgC) : null;
        databases.push({
          db: action.db,
          engine: action.engine,
          ownerRole: action.ownerRole,
          schemaRev,
          sizeBytes: fileSize(outPath),
          file: action.file,
        });
      }

      writeManifest(dir, {
        schemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
        fixtureId: input.fixtureId,
        profile: input.profile,
        createdAt: input.flow.bakedAt,
        databases,
        systems: plan.systems,
        flowId: `${input.flow.spa}/${input.flow.flow}`,
        flow: input.flow,
      });
    },

    async restore(snapshot: SnapshotManifest, opts: { currentProfile?: string }): Promise<void> {
      const localMigrations = gatherLocalMigrations(snapshot, deps.ctx, m);
      const plan = restorePlan(snapshot, m, localMigrations, {
        force: false,
        currentProfile: opts.currentProfile,
      });
      // M14: checkpoints are REPLAY substitutes, so unlike a generic snapshot
      // restore they must also not be BEHIND the local migration head (a full
      // replay would have migrated first; the generic guard only refuses AHEAD).
      const behind = checkpointBehindFailures(snapshot, localMigrations);
      if (!plan.ok || behind.length > 0) {
        throw new Error(
          `checkpoint '${snapshot.fixtureId}' cannot be restored:\n` +
            [...plan.guardFailures.map((g) => g.message), ...behind].map((msg) => `  ✗ ${msg}`).join('\n') +
            '\n  (re-bake with --snapshot-stages after updating the stack)',
        );
      }

      const pgC = postgresContainer();
      const mongoC = mongoContainer();
      await deps.io.assertPgRunning(pgC);
      if (plan.actions.some((a) => a.engine === 'mongo')) {
        await deps.io.assertMongoRunning(mongoC);
      }

      const dir = snapshotDir(snapshot.fixtureId);
      for (const action of plan.actions) {
        const inPath = join(dir, action.file);
        if (!existsSync(inPath)) {
          throw new Error(`checkpoint '${snapshot.fixtureId}' is missing dump file ${action.file} — re-bake`);
        }
        if (action.engine === 'mongo') {
          await deps.io.mongoRestore(mongoC, action.db, inPath);
        } else {
          await deps.io.pgRestore(action.db, pgC, action.ownerRole, inPath);
        }
      }

      if (plan.flushRedis) await deps.io.redisFlushdb(redisContainer());
    },
  };
}
