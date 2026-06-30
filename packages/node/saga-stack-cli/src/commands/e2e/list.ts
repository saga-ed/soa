/**
 * `saga-stack e2e list` — list the saga-dash journey phases (M2 thin wrapper).
 *
 * Maps to `e2eMap.e2eList()` → check-e2e.sh `--help`, which prints the canonical
 * phase table (number / name / status / description). The phase table lives in
 * the bash today; the richer `--flows` / `--projects` listings arrive with the
 * M5 flow registry (`flows.json`).
 *
 *   node bin/dev.js e2e list
 */

import { BaseCommand } from '../../base-command.js';
import * as e2eMap from '../../core/e2e-map.js';

export default class E2eList extends BaseCommand {
  static description = 'List the saga-dash journey phases (wraps check-e2e.sh --help).';

  static examples = ['<%= config.bin %> <%= command.id %>'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(E2eList);
    // Read-only listing; never fails on its own.
    await this.runScript(e2eMap.e2eList(), flags, { propagateExit: false });
  }
}
