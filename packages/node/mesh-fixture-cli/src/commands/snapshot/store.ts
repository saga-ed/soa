/**
 * snapshot:store — pg_dump each saga-mesh database into
 * ~/.saga-mesh/snapshots/<id>/<db>.dump + write manifest.json.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  assertPostgresRunning,
  formatBytes,
  snapshotDir,
  type SnapshotManifest,
} from '../../snapshot-store.js';
import {
  SAGA_MESH_DATABASES,
  POSTGRES_CONTAINER,
  dumpPathFor,
  ensureDir,
  fileSize,
  pgDump,
} from '../../lib/postgres.js';

export default class SnapshotStore extends BaseCommand {
  static description =
    'pg_dump all saga-mesh databases into ~/.saga-mesh/snapshots/<id>/.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': Flags.string({
      description: 'fixture identifier (e.g. "demo-small")',
      required: true,
    }),
    description: Flags.string({
      description: 'human description stored in manifest.json',
    }),
    force: Flags.boolean({
      description: 'overwrite an existing snapshot with the same id',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotStore);
    await assertPostgresRunning();

    const dir = snapshotDir(flags['fixture-id']);
    if (existsSync(dir) && !flags.force) {
      throw new Error(
        `snapshot '${flags['fixture-id']}' already exists at ${dir}. Use --force to overwrite.`,
      );
    }
    ensureDir(dir);

    this.log(`Storing snapshot '${flags['fixture-id']}' → ${dir}`);
    const databases: SnapshotManifest['databases'] = [];
    for (const db of SAGA_MESH_DATABASES) {
      const dumpFile = dumpPathFor(dir, db);
      process.stdout.write(`  dumping ${db.padEnd(18)} `);
      await pgDump(db, dumpFile);
      const size = fileSize(dumpFile);
      this.log(`${formatBytes(size)}`);
      databases.push({ name: db, dumpFile: `${db}.dump`, sizeBytes: size });
    }

    const manifest: SnapshotManifest = {
      fixtureId: flags['fixture-id'],
      description: flags.description,
      createdAt: new Date().toISOString(),
      container: POSTGRES_CONTAINER,
      seedProfile: process.env.SEED_PROFILE,
      databases,
      cliVersion: '0.0.1',
    };
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );

    const total = databases.reduce((n, d) => n + d.sizeBytes, 0);
    this.log(`\nstored ${databases.length} database(s), total ${formatBytes(total)}.`);
    this.log(`manifest: ${join(dir, 'manifest.json')}`);
  }
}
