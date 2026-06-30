/**
 * `saga-stack stack snapshot delete <fixture-id>` — remove a snapshot directory
 * (plan §4.3, §7.2 "M3"). Pure fs; no container IO.
 *
 *   node bin/dev.js stack snapshot delete demo-small
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { deleteSnapshot, snapshotDir, snapshotExists } from '../../../runtime/index.js';

export default class SnapshotDelete extends BaseCommand {
  static description = 'Delete a snapshot directory by fixture id.';

  static examples = ['<%= config.bin %> <%= command.id %> demo-small'];

  static args = {
    'fixture-id': Args.string({ description: 'fixture identifier to delete', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotDelete);
    const fixtureId = args['fixture-id'];
    const dir = snapshotDir(fixtureId);

    if (!snapshotExists(fixtureId)) {
      this.error(`snapshot '${fixtureId}' not found at ${dir}.`);
    }
    deleteSnapshot(fixtureId);

    this.emit(flags, { fixtureId, deleted: true, dir }, `deleted snapshot '${fixtureId}' (${dir}).`);
  }
}
