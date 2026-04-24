/**
 * pgm:create-period — thin spawn-and-relay shell.
 *
 * Composite logic lives in @saga-ed/pgm-seed (D3.8).
 */

import { existsSync } from 'node:fs';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { appendArtifact, recordCommand, sanitizeArgs } from '../../lib/registry.js';
import {
  resolvePgmSeedBin,
  spawnPgmSeed,
  extractUuidFromStdout,
} from '../../lib/pgm-seed-bin.js';

export default class PgmCreatePeriod extends BaseCommand {
  static description =
    'Create a period on a program — dedup by (programId, name). Delegates to pgm-seed.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    program: Flags.string({
      description: 'program name or UUID',
      required: true,
    }),
    name: Flags.string({
      description: 'period name',
      required: true,
    }),
    'sort-order': Flags.string({
      description: 'sort order',
      default: '0',
    }),
    'color-key': Flags.string({
      description: 'color key',
      default: 'blue',
    }),
    org: Flags.string({
      description: 'org slug or UUID (for program-name lookup + x-organization-id)',
      required: true,
    }),
    source: sourceFlag,
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PgmCreatePeriod);
    const binPath = resolvePgmSeedBin();
    if (!existsSync(binPath)) {
      this.logToStderr(
        `pgm-seed binary not found at ${binPath}. ` +
          'Build the package (cd ~/dev/program-hub/packages/node/pgm-seed && pnpm build) ' +
          'or set PGM_SEED_BIN to override.',
      );
      this.exit(2);
    }

    const args: string[] = ['create-period',
      '--fixture-id', flags['fixture-id'],
      '--program', flags.program,
      '--name', flags.name,
      '--org', flags.org,
      '--sort-order', flags['sort-order'],
      '--color-key', flags['color-key'],
      '--source', flags.source,
      '--as', flags.as,
      '--iam-url', flags['iam-url'],
      '--programs-url', flags['programs-url'],
    ];
    if (flags.porcelain) args.push('--porcelain');
    if (flags['output-json']) args.push('--output-json');

    const { exitCode, stdout } = await spawnPgmSeed(binPath, args);
    if (exitCode !== 0) {
      this.exit(exitCode);
    }

    const periodId = extractUuidFromStdout(stdout, 'periodId') ?? flags.name;
    await appendArtifact('pgm:create-period', flags['fixture-id'], 'periods', periodId, flags);
    await recordCommand('pgm:create-period', flags['fixture-id'], sanitizeArgs(flags), flags);
  }
}
