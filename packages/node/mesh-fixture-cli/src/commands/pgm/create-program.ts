/**
 * pgm:create-program — thin spawn-and-relay shell.
 *
 * Composite logic lives in @saga-ed/pgm-seed (D3.8). The CLI handles the
 * fixture-registry bookkeeping after the child exits 0; the child owns the
 * actual programs.create + dedup call.
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

export default class PgmCreateProgram extends BaseCommand {
  static description = 'Create a program — dedup by (org, name). Delegates to pgm-seed.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    name: Flags.string({
      description: 'program name',
      required: true,
    }),
    org: Flags.string({
      description: 'district group slug or UUID',
      required: true,
    }),
    timezone: Flags.string({
      description: 'IANA timezone',
      default: 'America/Los_Angeles',
    }),
    street: Flags.string({
      description: 'street address',
      default: '100 Demo Lane',
    }),
    city: Flags.string({
      description: 'city',
      default: 'Demo City',
    }),
    state: Flags.string({
      description: 'state',
      default: 'CA',
    }),
    zip: Flags.string({
      description: 'zip',
      default: '94000',
    }),
    source: sourceFlag,
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PgmCreateProgram);
    const binPath = resolvePgmSeedBin();
    if (!existsSync(binPath)) {
      this.logToStderr(
        `pgm-seed binary not found at ${binPath}. ` +
          'Build the package (cd ~/dev/program-hub/packages/node/pgm-seed && pnpm build) ' +
          'or set PGM_SEED_BIN to override.',
      );
      this.exit(2);
    }

    const args: string[] = ['create-program',
      '--fixture-id', flags['fixture-id'],
      '--name', flags.name,
      '--org', flags.org,
      '--timezone', flags.timezone,
      '--street', flags.street,
      '--city', flags.city,
      '--state', flags.state,
      '--zip', flags.zip,
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

    const programId = extractUuidFromStdout(stdout, 'programId') ?? flags.name;
    await appendArtifact('pgm:create-program', flags['fixture-id'], 'programs', programId, flags);
    await recordCommand('pgm:create-program', flags['fixture-id'], sanitizeArgs(flags), flags);
  }
}
