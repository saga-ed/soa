/**
 * iam:create-user — create a user with dedup by username (via users.search).
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag } from '../../shared-flags.js';
import { TrpcClient } from '../../lib/http.js';
import { findUserByUsername, type User } from '../../iam-helpers.js';
import { appendArtifact, recordCommand, sanitizeArgs } from '../../lib/registry.js';

export default class IamCreateUser extends BaseCommand {
  static description = 'Create a user — dedup by username (via users.search).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    username: Flags.string({
      description: 'unique username (dedup key)',
      required: true,
    }),
    email: Flags.string({
      description: 'email',
      required: true,
    }),
    'name-first': Flags.string({
      description: 'first name',
      default: 'Demo',
    }),
    'name-last': Flags.string({
      description: 'last name',
    }),
    'screen-name': Flags.string({
      description: 'screen name (defaults to username)',
    }),
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamCreateUser);
    const client = new TrpcClient({ baseUrl: flags['iam-url'] });

    const existing = await findUserByUsername(client, flags.username);
    if (existing) {
      this.emit(
        flags,
        { userId: existing.id, username: existing.username, dedup: 'hit' },
        `  hit    user/${flags.username} → ${existing.id}`,
      );
      await appendArtifact('iam:create-user', flags['fixture-id'], 'users', existing.id, flags);
      await recordCommand('iam:create-user', flags['fixture-id'], sanitizeArgs(flags), flags);
      return;
    }

    // iam-api's users.create accepts UserInput shape from PR #101.
    const created = await client.mutation<User>('users.create', {
      username: flags.username,
      profile: {
        screenName: flags['screen-name'] ?? flags.username,
        primaryLanguage: 'en',
      },
      pii: {
        email: flags.email,
        nameFirst: flags['name-first'],
        nameLast: flags['name-last'] ?? flags.username,
      },
    });
    this.emit(
      flags,
      { userId: created.id, username: created.username, dedup: 'miss' },
      `  new    user/${flags.username} → ${created.id}`,
    );
    await appendArtifact('iam:create-user', flags['fixture-id'], 'users', created.id, flags);
    await recordCommand('iam:create-user', flags['fixture-id'], sanitizeArgs(flags), flags);
  }
}
