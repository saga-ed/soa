/**
 * pgm:create-period — create a period on a program. Dedup by
 * (programId, name) via periods.list.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { TrpcClient } from '../../lib/http.js';
import { devLogin } from '../../lib/auth.js';
import { looksLikeUuid, resolveGroupId } from '../../iam-helpers.js';

interface Program {
  id: string;
  name: string;
  organizationId: string;
}

interface Period {
  id: string;
  name: string;
  programId: string;
}

export default class PgmCreatePeriod extends BaseCommand {
  static description =
    'Create a period on a program — dedup by (programId, name).';

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

    const iamClient = new TrpcClient({ baseUrl: flags['iam-url'] });
    const orgId = await resolveGroupId(iamClient, flags.source, flags.org);
    const { cookie } = await devLogin(flags['iam-url'], flags.as);
    const programsClient = new TrpcClient({
      baseUrl: flags['programs-url'],
      cookie,
      headers: { 'x-organization-id': orgId },
    });

    // Resolve programId via programs.list + name match (if arg isn't a UUID).
    let programId: string;
    if (looksLikeUuid(flags.program)) {
      programId = flags.program;
    } else {
      const resp = await programsClient.query<{ programs: Program[] }>(
        'programs.list',
        { page: 1, limit: 200 },
      );
      const p = resp.programs.find((x) => x.name === flags.program);
      if (!p) throw new Error(`program with name='${flags.program}' not found for org.`);
      programId = p.id;
    }

    // Dedup: list existing periods on this program and match by name.
    // periods.list returns a direct array (not paged).
    let existing: Period | null = null;
    try {
      const periods = await programsClient.query<Period[]>('periods.list', {
        programId,
      });
      existing = periods.find((p) => p.name === flags.name) ?? null;
    } catch {
      // Fall through — create will either succeed or duplicate-error which
      // we'd treat as hit.
    }
    if (existing) {
      this.emit(
        flags,
        { periodId: existing.id, name: existing.name, dedup: 'hit' },
        `  hit    period/${flags.name} → ${existing.id}`,
      );
      return;
    }

    const created = await programsClient.mutation<Period>('periods.create', {
      programId,
      name: flags.name,
      sortOrder: Number.parseInt(flags['sort-order'], 10),
      colorKey: flags['color-key'],
    });
    this.emit(
      flags,
      { periodId: created.id, name: created.name, dedup: 'miss' },
      `  new    period/${flags.name} → ${created.id}`,
    );
  }
}
