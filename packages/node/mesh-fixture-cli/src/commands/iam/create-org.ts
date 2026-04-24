/**
 * iam:create-org — create a group (org / school / section) with dedup by
 * (source, sourceId) via groups.findBySourceBulk.
 *
 * Auth: assumes iam-api is running with AUTH_AUTHENABLED=false; protected
 * procedures are reachable without a session cookie. --as is accepted for
 * forward-compat but currently ignored.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { TrpcClient } from '../../lib/http.js';
import {
  findGroupBySourceId,
  type Group,
} from '../../iam-helpers.js';

export default class IamCreateOrg extends BaseCommand {
  static description =
    'Create a group (org/school/section) — dedup by (source, sourceId).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    slug: Flags.string({
      description: 'stable slug; becomes sourceId',
      required: true,
    }),
    kind: Flags.string({
      description: 'group kind (e.g. district | school | section)',
      required: true,
    }),
    parent: Flags.string({
      description: 'parent group slug (must already exist)',
    }),
    'display-name': Flags.string({
      description: 'human display name (defaults to slug)',
    }),
    source: sourceFlag,
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamCreateOrg);
    const client = new TrpcClient({ baseUrl: flags['iam-url'] });

    const existing = await findGroupBySourceId(client, flags.source, flags.slug);
    if (existing) {
      this.emit(
        flags,
        { groupId: existing.id, kind: existing.kind, dedup: 'hit' },
        `  hit    ${existing.kind}/${flags.slug} → ${existing.id}`,
      );
      return;
    }

    let parentGroupId: string | undefined;
    if (flags.parent) {
      const parent = await findGroupBySourceId(client, flags.source, flags.parent);
      if (!parent) {
        throw new Error(
          `parent group with sourceId='${flags.parent}' not found. Create it first.`,
        );
      }
      parentGroupId = parent.id;
    }

    const created = await client.mutation<Group>('groups.create', {
      kind: flags.kind,
      displayName: flags['display-name'] ?? flags.slug,
      parentGroupId,
      source: flags.source,
      sourceId: flags.slug,
    });
    this.emit(
      flags,
      { groupId: created.id, kind: created.kind, dedup: 'miss' },
      `  new    ${created.kind}/${flags.slug} → ${created.id}`,
    );
  }
}
