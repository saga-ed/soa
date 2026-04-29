/**
 * snapshot:delete — rm -rf ~/.saga-mesh/snapshots/<id>/.
 */

import { existsSync, rmSync } from 'node:fs';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { snapshotDir } from '../../snapshot-store.js';

export default class SnapshotDelete extends BaseCommand {
  static description = 'rm -rf ~/.saga-mesh/snapshots/<id>/.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': Flags.string({
      description: 'fixture identifier to delete',
      required: true,
    }),
    yes: Flags.boolean({
      description: 'skip confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotDelete);
    const dir = snapshotDir(flags['fixture-id']);
    if (!existsSync(dir)) {
      this.log(`snapshot '${flags['fixture-id']}' not found at ${dir}`);
      return;
    }
    if (!flags.yes) {
      throw new Error(
        `Refusing to delete ${dir} without --yes. Pass --yes to confirm.`,
      );
    }
    rmSync(dir, { recursive: true, force: true });
    this.log(`removed ${dir}`);
  }
}
