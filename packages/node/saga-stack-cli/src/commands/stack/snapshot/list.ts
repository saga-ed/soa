/**
 * `saga-stack stack snapshot list` — enumerate snapshots on disk (plan §4.3,
 * §7.2 "M3"). Read-only; supersedes mesh-fixture-cli's `snapshot:list` and
 * subsumes its `snapshot:show` (use `--output-json` for the full manifest).
 *
 * Scans `$SAGA_MESH_SNAPSHOTS_DIR` (default ~/.saga-mesh/snapshots), newest
 * first, surfacing each snapshot's profile, DB count, and per-DB schemaRevs from
 * the zod-validated manifest.
 *
 *   node bin/dev.js stack snapshot list
 *   node bin/dev.js stack snapshot list --output-json
 */

import { BaseCommand } from '../../../base-command.js';
import { formatBytes, scanSnapshots, snapshotsRoot } from '../../../runtime/index.js';

export default class SnapshotList extends BaseCommand {
  static description = 'List the snapshots on disk under $SAGA_MESH_SNAPSHOTS_DIR (read-only).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output-json',
  ];

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
        this.log(`No snapshots found under ${snapshotsRoot()}.`);
        this.log('  Create one: saga-stack stack snapshot store --fixture-id <name>');
      }
      return;
    }

    if (flags.porcelain) {
      for (const e of entries) {
        const profile = e.manifest?.profile ?? '';
        const dbs = e.manifest?.databases.length ?? 0;
        this.log(`${e.fixtureId}\t${profile}\t${dbs}\t${e.sizeBytes}\t${e.mtime.toISOString()}`);
      }
      return;
    }

    this.log(`Snapshots under ${snapshotsRoot()}:`);
    this.log('');
    this.log('  ' + 'ID'.padEnd(26) + 'PROFILE'.padEnd(10) + 'DBS'.padEnd(6) + 'SIZE'.padEnd(11) + 'MODIFIED');
    this.log('  ' + '─'.repeat(78));
    for (const e of entries) {
      const profile = e.manifest?.profile ?? '—';
      const dbs = e.manifest?.databases.length ?? 0;
      this.log(
        '  ' +
          e.fixtureId.padEnd(26) +
          profile.padEnd(10) +
          String(dbs).padEnd(6) +
          formatBytes(e.sizeBytes).padEnd(11) +
          e.mtime.toISOString(),
      );
      const revs = (e.manifest?.databases ?? [])
        .filter((d) => d.schemaRev)
        .map((d) => `${d.db}@${d.schemaRev}`);
      if (revs.length > 0) this.log('    ' + revs.join('  '));
    }
  }
}
