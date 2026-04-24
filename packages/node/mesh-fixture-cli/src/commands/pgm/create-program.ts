/**
 * pgm:create-program — create a program under an org. Dedup by
 * (organizationId, name) via programs.list. Auth: devLogin as --as
 * against iam-api, then carry the iam_session cookie on programs-api calls
 * with x-organization-id resolved from --org.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { TrpcClient, TrpcCallError } from '../../lib/http.js';
import { devLogin } from '../../lib/auth.js';
import { resolveGroupId } from '../../iam-helpers.js';
import { appendArtifact, recordCommand, sanitizeArgs } from '../../lib/registry.js';

interface Program {
  id: string;
  name: string;
  organizationId: string;
}

export default class PgmCreateProgram extends BaseCommand {
  static description = 'Create a program — dedup by (organizationId, name).';

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

    const iamClient = new TrpcClient({ baseUrl: flags['iam-url'] });
    const orgId = await resolveGroupId(iamClient, flags.source, flags.org);
    const { cookie } = await devLogin(flags['iam-url'], flags.as);

    const programsClient = new TrpcClient({
      baseUrl: flags['programs-url'],
      cookie,
      headers: { 'x-organization-id': orgId },
    });

    // Dedup: list programs for this org, match by name. programs.list is
    // paged + wrapped: { programs: [...], total, page, limit }. Pull a large
    // first page rather than walk pages — seed volumes are small.
    let existing: Program | null = null;
    try {
      const resp = await programsClient.query<{ programs: Program[] }>(
        'programs.list',
        { page: 1, limit: 200 },
      );
      existing = resp.programs.find((p) => p.name === flags.name) ?? null;
    } catch (err) {
      // If programs.list is unavailable, fall through — a duplicate-name
      // create will throw, which we can treat as hit.
      if (!(err instanceof TrpcCallError && err.status === 404)) throw err;
    }
    if (existing) {
      this.emit(
        flags,
        { programId: existing.id, name: existing.name, dedup: 'hit' },
        `  hit    program/${flags.name} → ${existing.id}`,
      );
      await appendArtifact('pgm:create-program', flags['fixture-id'], 'programs', existing.id, flags);
      await recordCommand('pgm:create-program', flags['fixture-id'], sanitizeArgs(flags), flags);
      return;
    }

    const created = await programsClient.mutation<Program>('programs.create', {
      name: flags.name,
      timezone: flags.timezone,
      streetAddress: flags.street,
      city: flags.city,
      state: flags.state,
      zip: flags.zip,
    });
    this.emit(
      flags,
      { programId: created.id, name: created.name, dedup: 'miss' },
      `  new    program/${flags.name} → ${created.id}`,
    );
    await appendArtifact('pgm:create-program', flags['fixture-id'], 'programs', created.id, flags);
    await recordCommand('pgm:create-program', flags['fixture-id'], sanitizeArgs(flags), flags);
  }
}
