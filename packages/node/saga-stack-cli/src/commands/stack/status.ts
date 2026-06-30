/**
 * `saga-stack stack status` — health + row counts for the running stack
 * (M1 thin wrapper).
 *
 * Maps to `flagMap.status()` → `up.sh --status`: up.sh prints health and DB row
 * counts, then exits. status is READ-ONLY: it must never fail on its own, so we
 * pass `propagateExit:false` — the wrapper always exits 0 regardless of up.sh's
 * status exit code (a degraded stack is reported, not an error of `status`).
 *
 *   node bin/dev.js stack status
 */

import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';

export default class StackStatus extends BaseCommand {
  static description = 'Show stack health and DB row counts (wraps up.sh --status; read-only).';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackStatus);
    await this.runScript(flagMap.status(), flags, { propagateExit: false });
  }
}
