/**
 * snapshot:restore — pg_restore a named snapshot over the running saga-mesh,
 * then redis-cli FLUSHDB.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  assertPostgresRunning,
  assertRedisRunning,
  readManifest,
  snapshotDir,
} from '../../snapshot-store.js';
import { pgRestore, redisFlushdb } from '../../lib/postgres.js';

export default class SnapshotRestore extends BaseCommand {
  static description =
    'pg_restore a named snapshot over the running saga-mesh, then FLUSHDB redis.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': Flags.string({
      description: 'fixture identifier to restore',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotRestore);
    await assertPostgresRunning();
    await assertRedisRunning();

    const dir = snapshotDir(flags['fixture-id']);
    const manifest = readManifest(dir);
    if (!manifest) {
      throw new Error(
        `no manifest found at ${dir}/manifest.json (run snapshot:list to see what exists).`,
      );
    }

    this.log(`Restoring snapshot '${flags['fixture-id']}' from ${dir}`);
    this.log(`  stored: ${manifest.createdAt}`);
    if (manifest.description) this.log(`  desc:   ${manifest.description}`);

    for (const db of manifest.databases) {
      const dumpPath = join(dir, db.dumpFile);
      if (!existsSync(dumpPath)) {
        throw new Error(`missing dump file: ${dumpPath}`);
      }
      process.stdout.write(`  restoring ${db.name.padEnd(18)} `);
      await pgRestore(db.name, dumpPath);
      this.log('ok');
    }

    this.log('\n  FLUSHDB saga-mesh-redis (rostering cache invalidation)');
    await redisFlushdb();

    this.log(`\nrestored ${manifest.databases.length} database(s).`);
    this.log(
      `  note: apps (pnpm dev) may hold stale prisma clients — bounce them if reads look odd.`,
    );
  }
}
