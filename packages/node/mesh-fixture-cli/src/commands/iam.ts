/**
 * iam:* — rostering iam-api seed commands.
 *
 * Planned commands:
 *   iam:create-org   --fixture-id <id> --slug <slug> --kind <kind> [--parent <slug|uuid>]
 *   iam:create-user  --fixture-id <id> --username <x> --email <x> --role <x>
 *   iam:add-membership --fixture-id <id> --user <uuid|username> --group <uuid|slug>
 *
 * All are tRPC-driven against iam-api. Dedup by natural key — calling
 * iam:create-org twice with the same slug is a no-op after the first.
 *
 * Status: stubs. Land under D3.1 step 2 after fixture:list validates the
 * package plumbing.
 */

import type { Command } from 'commander';

export function registerIamCommands(program: Command): void {
  const iam = program
    .command('iam')
    .description('rostering iam-api seed commands (create-org, create-user, add-membership).');

  iam
    .command('create-org')
    .description('Create an organization/group (dedup by source + sourceId).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--slug <slug>', 'stable slug (used as sourceId)')
    .requiredOption('--kind <kind>', 'group kind (district | school | section | ...)')
    .option('--parent <slug-or-uuid>', 'parent group slug or UUID')
    .option('--display-name <name>', 'human display name (defaults to slug)')
    .action(() => {
      console.error('iam:create-org — not yet implemented (D3.1 step 2).');
      process.exitCode = 2;
    });

  iam
    .command('create-user')
    .description('Create a user (dedup by username).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--username <username>', 'username (dedup key)')
    .requiredOption('--email <email>', 'email')
    .option('--name-first <first>', 'first name')
    .option('--name-last <last>', 'last name')
    .option('--role <role>', 'role (STUDENT | TUTOR | ADMIN)', 'STUDENT')
    .action(() => {
      console.error('iam:create-user — not yet implemented (D3.1 step 2).');
      process.exitCode = 2;
    });

  iam
    .command('add-membership')
    .description('Add a user to a group (enforces top-down parent ordering).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--user <username-or-uuid>', 'user')
    .requiredOption('--group <slug-or-uuid>', 'group')
    .action(() => {
      console.error('iam:add-membership — not yet implemented (D3.1 step 2).');
      process.exitCode = 2;
    });
}
