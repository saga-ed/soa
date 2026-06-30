/**
 * `saga-stack stack restart` — clean bounce of the stack (M1 thin wrapper).
 *
 * Maps to `flagMap.restart()` → `up.sh restart` (a LEADING verb in up.sh, not a
 * trailing flag): a clean bounce with no data wipe. Reset/seed during a restart
 * are not part of this M1 mapper.
 *
 *   node bin/dev.js stack restart
 */

import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';

export default class StackRestart extends BaseCommand {
  static description = 'Cleanly bounce the stack (wraps up.sh restart; no data wipe).';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackRestart);
    await this.runScript(flagMap.restart(), flags);
  }
}
