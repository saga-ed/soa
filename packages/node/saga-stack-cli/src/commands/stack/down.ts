/**
 * `saga-stack stack down` — stop the running stack (M1 thin wrapper).
 *
 * Maps to `flagMap.down()` → `up.sh --down`: up.sh skips the up path, stops the
 * services, and leaves the mesh (postgres/rabbitmq/…) up. The plan's NEW
 * `--mesh` (also tear the mesh down) has no up.sh antecedent and is NOT in M1.
 *
 *   node bin/dev.js stack down
 */

import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';

export default class StackDown extends BaseCommand {
  static description = 'Stop the running stack (wraps up.sh --down; leaves the mesh up).';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackDown);
    await this.runScript(flagMap.down(), flags);
  }
}
