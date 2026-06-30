/**
 * `saga-stack stack snapshot restore` — native DB restore fast-path (plan §4.3,
 * §7.2 "M3"). Supersedes mesh-fixture-cli's `snapshot:restore`.
 *
 * RESTORES a named snapshot over the running stack: `pg_restore --clean
 * --if-exists` (AS each DB's OWNER role — snapshot invariant: ledger_local → the
 * `ledger` role) and `mongorestore --archive --drop`, then optionally flushes
 * redis (rostering cache invalidation, PR #82). Two pure guards (in
 * `restorePlan`) gate the restore BEFORE any IO:
 *   - PROFILE mismatch (snapshot vs live SEED_PROFILE) — bypassable with --force.
 *   - SNAPSHOT-AHEAD (a pg DB's recorded `schemaRev` is unknown in the local
 *     checkout) — HARD; the snapshot is newer than your code, run `stack up --pull`.
 *
 * THIN: the pure `restorePlan` orders the actions + evaluates the guards; the
 * injectable `SnapshotIO` (`this.getSnapshotIO()`) does the `docker exec`. Local
 * migration ids (the snapshot-ahead guard input) are read off disk by the
 * runtime layer via `gatherLocalMigrations` (overridable for tests).
 *
 *   node bin/dev.js stack snapshot restore demo-small
 *   node bin/dev.js stack snapshot restore demo-small --only iam-api
 *   node bin/dev.js stack snapshot restore demo-small --force
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { DbId, RepoKey as ManifestRepoKey, ServiceId } from '../../../core/manifest/index.js';
import { restorePlan, snapshotManifestSchema } from '../../../core/snapshot/index.js';
import type { LocalMigrations, SnapshotManifest } from '../../../core/snapshot/index.js';
import {
  gatherLocalMigrations,
  mongoContainer,
  postgresContainer,
  readManifest,
  redisContainer,
  snapshotDir,
  REPO_ENV_VAR,
} from '../../../runtime/index.js';
import type { RepoKey, ScriptContext } from '../../../runtime/index.js';

export default class SnapshotRestore extends BaseCommand {
  static description =
    'Restore a named snapshot over the running stack (pg_restore + mongorestore, AS owner), then flush redis.';

  static examples = [
    '<%= config.bin %> <%= command.id %> demo-small',
    '<%= config.bin %> <%= command.id %> demo-small --only iam-api',
    '<%= config.bin %> <%= command.id %> demo-small --force',
  ];

  static args = {
    'fixture-id': Args.string({ description: 'fixture identifier to restore', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'restore only the DBs in the dependency closure of these services (comma-list)',
    }),
    force: Flags.boolean({
      description: 'bypass the profile-mismatch guard (does NOT bypass the snapshot-ahead guard)',
      default: false,
    }),
    'flush-redis': Flags.boolean({
      description: 'flush redis after restore (rostering cache invalidation)',
      default: true,
      allowNo: true,
    }),
  };

  /**
   * Read the local prisma migration ids per DB (the snapshot-ahead guard input).
   * A protected seam so tests can substitute a controlled set without a checkout
   * on disk — mirrors how `getSnapshotIO` isolates the container IO.
   */
  protected localMigrationsFor(snapshot: SnapshotManifest, ctx: ScriptContext): LocalMigrations {
    return gatherLocalMigrations(snapshot, ctx);
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestore);
    const fixtureId = args['fixture-id'];

    const dir = snapshotDir(fixtureId);
    const full = readManifest(dir);
    if (!full) {
      this.error(
        `no valid snapshot manifest at ${join(dir, 'manifest.json')} ` +
          `(run \`stack snapshot list\` to see what exists).`,
      );
    }

    // --only: restrict to the closure's DB set ∩ the snapshot's DBs.
    const snapshot = flags.only
      ? scopeSnapshot(full, flags.only, (m) => this.error(m))
      : full;

    const ctx = workspaceContext(flags);
    const localMigrations = this.localMigrationsFor(snapshot, ctx);

    const plan = restorePlan(snapshot, manifest, localMigrations, {
      force: flags.force,
      currentProfile: process.env.SEED_PROFILE,
    });

    if (!plan.ok) {
      this.error(plan.guardFailures.map((g) => g.message).join('\n'));
    }

    const io = this.getSnapshotIO();
    const pgC = postgresContainer();
    const mongoC = mongoContainer();

    await io.assertPgRunning(pgC);
    if (plan.actions.some((a) => a.engine === 'mongo')) {
      await io.assertMongoRunning(mongoC);
    }

    for (const action of plan.actions) {
      const inPath = join(dir, action.file);
      if (!existsSync(inPath)) {
        this.error(`missing dump file for '${action.db}': ${inPath}`);
      }
      if (action.engine === 'mongo') {
        await io.mongoRestore(mongoC, action.db, inPath);
      } else {
        await io.pgRestore(action.db, pgC, action.ownerRole, inPath);
      }
    }

    const flushedRedis = plan.flushRedis && flags['flush-redis'];
    if (flushedRedis) {
      await io.redisFlushdb(redisContainer());
    }

    this.emit(
      flags,
      {
        fixtureId,
        databases: plan.actions.length,
        restoredServices: plan.restoredServices,
        flushedRedis,
      },
      [
        `restored snapshot '${fixtureId}' (${plan.actions.length} database(s))`,
        ...plan.actions.map((a) => `  ${a.db.padEnd(18)} ← ${a.file}`),
        plan.restoredServices.length > 0
          ? `fully-restored services: ${plan.restoredServices.join(', ')}`
          : 'no service fully restored (partial scope) — scratch seeds still apply.',
        flushedRedis ? 'flushed redis (rostering cache invalidation).' : 'skipped redis flush.',
      ],
    );
  }
}

/**
 * Build a sub-snapshot scoped to the closure DB set of `--only <svc,…>`,
 * preserving each retained DB's recorded metadata. Fails if the scope resolves
 * to no DB present in the snapshot.
 */
export function scopeSnapshot(
  snapshot: SnapshotManifest,
  only: string,
  fail: (msg: string) => never,
): SnapshotManifest {
  // Resolve the requested services to their closure DB set (playback included so
  // a playback DB can be scoped in), then keep only the snapshot DBs in that set.
  const requested = only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ServiceId[];
  const known = new Set(Object.keys(manifest.services));
  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    fail(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
  }

  const dbSet = new Set<DbId>(computeClosure(manifest, requested, { withPlayback: true }).databases);
  const databases = snapshot.databases.filter((d) => dbSet.has(d.db));
  if (databases.length === 0) {
    fail(
      `--only resolved to no database present in snapshot '${snapshot.fixtureId}'.\n` +
        `  snapshot DBs: ${snapshot.databases.map((d) => d.db).join(', ') || '(none)'}`,
    );
  }
  return snapshotManifestSchema.parse({ ...snapshot, databases });
}

/** Build the script/path resolution context from the shared workspace flags. */
function workspaceContext(flags: { dev?: string } & Partial<Record<RepoKey, string>>): ScriptContext {
  const repoRoots: Partial<Record<ManifestRepoKey, string>> = {};
  for (const repo of Object.keys(REPO_ENV_VAR) as RepoKey[]) {
    const value = flags[repo];
    if (value) repoRoots[REPO_ENV_VAR[repo] as ManifestRepoKey] = value;
  }
  return { dev: flags.dev, repoRoots };
}
