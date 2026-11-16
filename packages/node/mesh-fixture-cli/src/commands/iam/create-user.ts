/**
 * iam:create-user — create a user, dedup by email.
 *
 * IAM `username` is retired (rostering docs/iam/identity_fields_cleanup.md):
 * there is no --username flag any more, and fixtures recorded with one must be
 * re-recorded. See findUserIdByEmail for how the dedup lookup works.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { asFlag, fixtureIdFlag } from '../../shared-flags.js';
import { TrpcClient } from '../../lib/http.js';
import { findUserIdByEmail, type User } from '../../iam-helpers.js';
import { appendArtifact, recordCommand, sanitizeArgs } from '../../lib/registry.js';

export default class IamCreateUser extends BaseCommand {
  static description = 'Create a user — dedup by email (via auth.devLogin; dev stacks only).';

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': fixtureIdFlag,
    email: Flags.string({
      description: 'email (dedup key)',
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
      description: 'screen name (defaults to the email local part)',
    }),
    as: asFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IamCreateUser);
    const client = new TrpcClient({ baseUrl: flags['iam-url'] });

    const localPart = flags.email.split('@')[0];
    const existingId = await findUserIdByEmail(client, flags.email);
    if (existingId) {
      this.emit(
        flags,
        { userId: existingId, email: flags.email, dedup: 'hit' },
        `  hit    user/${flags.email} → ${existingId}`,
      );
      await appendArtifact('iam:create-user', flags['fixture-id'], 'users', existingId, flags);
      await recordCommand('iam:create-user', flags['fixture-id'], sanitizeArgs(flags), flags);
      return;
    }

    // iam-api's users.create accepts UserInput shape from PR #101.
    const created = await client.mutation<User>('users.create', {
      profile: {
        screenName: flags['screen-name'] ?? localPart,
        primaryLanguage: 'en',
      },
      pii: {
        email: flags.email,
        nameFirst: flags['name-first'],
        nameLast: flags['name-last'] ?? localPart,
      },
    });
    this.emit(
      flags,
      { userId: created.id, email: flags.email, dedup: 'miss' },
      `  new    user/${flags.email} → ${created.id}`,
    );
    await appendArtifact('iam:create-user', flags['fixture-id'], 'users', created.id, flags);
    await recordCommand('iam:create-user', flags['fixture-id'], sanitizeArgs(flags), flags);
  }
}
