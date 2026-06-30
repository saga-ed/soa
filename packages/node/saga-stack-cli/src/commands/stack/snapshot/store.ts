/**
 * `saga-stack stack snapshot store` — native DB snapshot fast-path (plan §4.3,
 * §7.2 "M3"). Supersedes mesh-fixture-cli's `snapshot:store`.
 *
 * DUMPS every database the snapshot scope covers — all 9 postgres app DBs + the
 * connectv3 MONGO DB by default (mesh-fixture-cli only knew 6 pg DBs) — into
 * `~/.saga-mesh/snapshots/<fixture-id>/` and writes a zod-validated
 * `manifest.json` recording each DB's engine, owner role, captured `schemaRev`
 * (the `_prisma_migrations` head; null for db-push / mongo), and dump size.
 *
 * THIN: the pure `storePlan` (core/snapshot) decides WHICH DBs to dump; the
 * injectable `SnapshotIO` (runtime/snapshot — `this.getSnapshotIO()`) does the
 * `docker exec pg_dump/mongodump/psql`. Tests spy `getSnapshotIO` to capture the
 * calls with no real container, DB, or dump file.
 *
 *   node bin/dev.js stack snapshot store --fixture-id demo-small
 *   node bin/dev.js stack snapshot store --fixture-id full --profile full --with-playback
 *   node bin/dev.js stack snapshot store --fixture-id iam --only iam-api
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { DbId, ServiceId } from '../../../core/manifest/index.js';
import { storePlan, CURRENT_SNAPSHOT_SCHEMA_VERSION } from '../../../core/snapshot/index.js';
import type { SnapshotDbEntry, SnapshotManifest } from '../../../core/snapshot/index.js';
import {
  ensureSnapshotDir,
  fileSize,
  formatBytes,
  mongoContainer,
  postgresContainer,
  snapshotDir,
  writeManifest,
} from '../../../runtime/index.js';

export default class SnapshotStore extends BaseCommand {
  static description =
    'Dump all stack databases (9 pg app DBs + connectv3 mongo) into a named snapshot.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --fixture-id demo-small',
    '<%= config.bin %> <%= command.id %> --fixture-id full --profile full --with-playback',
    '<%= config.bin %> <%= command.id %> --fixture-id iam --only iam-api',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': Flags.string({
      description: 'fixture identifier (= snapshot directory name)',
      required: true,
    }),
    profile: Flags.string({
      description: 'SEED_PROFILE stamped into the manifest (drives the restore profile guard)',
      default: 'roster',
    }),
    only: Flags.string({
      description:
        'scope the dump to the dependency closure of these services (comma-list); overrides --with-playback',
    }),
    'with-playback': Flags.boolean({
      description: 'also dump the optional playback DBs (transcripts, insights, chat)',
      default: false,
    }),
    force: Flags.boolean({
      description: 'overwrite an existing snapshot with the same fixture id',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotStore);
    const fixtureId = flags['fixture-id'];

    const only = flags.only
      ? closureDatabases(flags.only, flags['with-playback'], (m) => this.error(m))
      : undefined;

    const plan = storePlan(manifest, {
      fixtureId,
      profile: flags.profile,
      only,
      withPlayback: flags['with-playback'],
    });

    const io = this.getSnapshotIO();
    const pgC = postgresContainer();
    const mongoC = mongoContainer();

    // Fail fast (actionable) if the containers the dump targets are down.
    await io.assertPgRunning(pgC);
    if (plan.databases.some((d) => d.engine === 'mongo')) {
      await io.assertMongoRunning(mongoC);
    }

    const dir = snapshotDir(fixtureId);
    if (existsSync(dir) && !flags.force) {
      this.error(`snapshot '${fixtureId}' already exists at ${dir}. Use --force to overwrite.`);
    }
    ensureSnapshotDir(dir);

    const databases: SnapshotDbEntry[] = [];
    for (const action of plan.databases) {
      const outPath = join(dir, action.file);
      if (action.engine === 'mongo') {
        await io.mongoDump(mongoC, action.db, outPath);
      } else {
        await io.pgDump(action.db, pgC, action.ownerRole, outPath);
      }
      const schemaRev = action.captureSchemaRev ? await io.readSchemaRev(action.db, pgC) : null;
      databases.push({
        db: action.db,
        engine: action.engine,
        ownerRole: action.ownerRole,
        schemaRev,
        sizeBytes: fileSize(outPath),
        file: action.file,
      });
    }

    const snapshot: SnapshotManifest = {
      schemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
      fixtureId,
      profile: flags.profile,
      createdAt: new Date().toISOString(),
      databases,
      systems: plan.systems,
    };
    writeManifest(dir, snapshot);

    const totalBytes = databases.reduce((n, d) => n + (d.sizeBytes ?? 0), 0);

    this.emit(
      flags,
      {
        fixtureId,
        dir,
        profile: flags.profile,
        databases: databases.length,
        totalBytes,
        systems: snapshot.systems ?? [],
      },
      [
        `stored snapshot '${fixtureId}' → ${dir}`,
        ...databases.map(
          (d) => `  ${d.db.padEnd(18)} ${formatBytes(d.sizeBytes ?? 0).padStart(10)}` +
            (d.schemaRev ? `  @${d.schemaRev}` : ''),
        ),
        `${databases.length} database(s), total ${formatBytes(totalBytes)}.`,
      ],
    );
  }
}

/**
 * Resolve a `--only <svc,…>` list to its closure's DB set (`DbId[]`). Mirrors
 * `status`'s `resolveServiceSet`: unknown ids fail with a friendly oclif error.
 */
export function closureDatabases(
  only: string,
  withPlayback: boolean,
  fail: (msg: string) => never,
): DbId[] {
  const requested = only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ServiceId[];

  const known = new Set(Object.keys(manifest.services));
  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    fail(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
  }

  return computeClosure(manifest, requested, { withPlayback }).databases;
}
