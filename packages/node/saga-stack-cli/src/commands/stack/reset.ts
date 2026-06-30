/**
 * `saga-stack stack reset` — truncate + re-seed the data DBs (M1 thin wrapper).
 *
 * Maps to `flagMap.reset({ withPlayback })` → `up.sh --reset` (+ `--with-playback`
 * to also truncate the opt-in playback DBs).
 *
 *   node bin/dev.js stack reset
 *   node bin/dev.js stack reset --with-playback
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';

export default class StackReset extends BaseCommand {
  static description = 'Truncate and re-seed the data DBs (wraps up.sh --reset).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --with-playback',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'with-playback': Flags.boolean({
      description: 'also truncate the opt-in playback DBs (up.sh --reset --with-playback)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackReset);
    await this.runScript(flagMap.reset({ withPlayback: flags['with-playback'] }), flags);
  }
}
