/**
 * iam:add-membership — add a user to a group by slug-or-UUID.
 * Parent-first ordering is enforced by iam itself. "Already member" errors
 * from groups.addMembers are absorbed as dedup=hit so the command is
 * idempotent.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag, sourceFlag } from '../../shared-flags.js';
import { TrpcClient, TrpcCallError } from '../../lib/http.js';
import {
  findGroupBySourceId,
  findUserByUsername,
  looksLikeUuid,
} from '../../iam-helpers.js';

export default class IamAddMembership extends BaseCommand {
  static description =
    'Add a user to a group by slug-or-UUID. Parent-first ordering enforced by iam.';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    user: Flags.string({
      description: 'user (username or UUID)',
      required: true,
    }),
    group: Flags.string({
      description: 'target group (sourceId or UUID)',
      required: true,
    }),
    source: sourceFlag,
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamAddMembership);
    const client = new TrpcClient({ baseUrl: flags['iam-url'] });

    // Resolve user (accept either UUID or username).
    let userId: string;
    if (looksLikeUuid(flags.user)) {
      userId = flags.user;
    } else {
      const user = await findUserByUsername(client, flags.user);
      if (!user) throw new Error(`user '${flags.user}' not found (by username).`);
      userId = user.id;
    }

    // Resolve group (accept either UUID or slug).
    let groupId: string;
    if (looksLikeUuid(flags.group)) {
      groupId = flags.group;
    } else {
      const group = await findGroupBySourceId(client, flags.source, flags.group);
      if (!group) throw new Error(`group '${flags.group}' not found (by sourceId).`);
      groupId = group.id;
    }

    try {
      // AddMembersInputSchema expects `members: [{userId, roleId?, source?}]`,
      // not a flat `userIds` array (that's RemoveMembers).
      await client.mutation('groups.addMembers', {
        groupId,
        members: [{ userId, source: flags.source }],
      });
    } catch (err) {
      // addMembers throws if the user is already a member. Absorb that
      // into dedup=hit so the command is idempotent.
      if (err instanceof TrpcCallError && /already/i.test(err.trpcError?.message ?? '')) {
        this.emit(
          flags,
          { userId, groupId, dedup: 'hit' },
          `  hit    membership ${userId.slice(0, 8)}... in ${groupId.slice(0, 8)}...`,
        );
        return;
      }
      throw err;
    }
    this.emit(
      flags,
      { userId, groupId, dedup: 'miss' },
      `  new    membership ${userId.slice(0, 8)}... in ${groupId.slice(0, 8)}...`,
    );
  }
}
