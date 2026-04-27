/**
 * fixture:list — list all fixtures on disk under SAGA_MESH_FIXTURES_DIR.
 */

import { BaseCommand } from '../../base-command.js';
import { FIXTURES_ROOT, formatBytes, scanFixtures } from '../../fixture-store.js';

export default class FixtureList extends BaseCommand {
  static description = 'List all fixtures on disk under SAGA_MESH_FIXTURES_DIR.';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(FixtureList);
    const entries = scanFixtures();

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
        this.log(`No fixtures found under ${FIXTURES_ROOT}.`);
        this.log(`  Create one: mesh-fixture fixture store --fixture-id <name>`);
      }
      return;
    }

    if (flags.porcelain) {
      for (const e of entries) {
        this.log(`${e.fixtureId}\t${e.sizeBytes}\t${e.mtime.toISOString()}`);
      }
      return;
    }

    this.log(`Fixtures under ${FIXTURES_ROOT}:`);
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
