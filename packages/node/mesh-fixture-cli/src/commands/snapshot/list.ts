/**
 * snapshot:list — list all snapshots on disk under SAGA_MESH_SNAPSHOTS_DIR.
 */

import { BaseCommand } from '../../base-command.js';
import { SNAPSHOTS_ROOT, formatBytes, scanSnapshots } from '../../snapshot-store.js';

export default class SnapshotList extends BaseCommand {
  static description = 'List all snapshots on disk under SAGA_MESH_SNAPSHOTS_DIR.';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotList);
    const entries = scanSnapshots();

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          entries.map((e) => ({
            fixtureId: e.fixtureId,
            path: e.path,
            sizeBytes: e.sizeBytes,
            modifiedAt: e.mtime.toISOString(),
            manifest: e.manifest,
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (entries.length === 0) {
      if (!flags.porcelain) {
        this.log(`No snapshots found under ${SNAPSHOTS_ROOT}.`);
        this.log(`  Create one: mesh-fixture snapshot:store --fixture-id <name>`);
      }
      return;
    }

    if (flags.porcelain) {
      for (const e of entries) {
        this.log(`${e.fixtureId}\t${e.sizeBytes}\t${e.mtime.toISOString()}`);
      }
      return;
    }

    this.log(`Snapshots under ${SNAPSHOTS_ROOT}:`);
    this.log('');
    this.log('  ' + 'ID'.padEnd(28) + 'SIZE'.padEnd(12) + 'MODIFIED');
    this.log('  ' + '─'.repeat(70));
    for (const e of entries) {
      this.log(
        '  ' +
          e.fixtureId.padEnd(28) +
          formatBytes(e.sizeBytes).padEnd(12) +
          e.mtime.toISOString(),
      );
      if (e.manifest?.description) {
        this.log('    ' + e.manifest.description);
      }
    }
  }
}
