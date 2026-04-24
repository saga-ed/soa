/**
 * ads:seed-attendance — deferred pending coordination with SDS PR #77
 * ("retire in-app mocks; seed postgres from CSVs"). See the phase-3 plan
 * appendix A.5 D3.1: if Seth's CSV seed produces the same data shape,
 * the mesh command wraps it rather than reinvent. Stub exits 2.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { fixtureIdFlag } from '../../shared-flags.js';

export default class AdsSeedAttendance extends BaseCommand {
  static description =
    'Seed attendance rows for a demo program × date (deferred).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    csv: Flags.string({
      description: 'CSV path (format TBD pending #77)',
    }),
  };

  async run(): Promise<void> {
    await this.parse(AdsSeedAttendance);
    this.logToStderr(
      'ads:seed-attendance — deferred pending Seth PR #77 coordination (plan A.5).',
    );
    this.exit(2);
  }
}
