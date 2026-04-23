/**
 * pgm:* — program-hub seed commands.
 *
 * Planned commands:
 *   pgm:create-program --fixture-id <id> --name <x> --org <slug-or-uuid>
 *   pgm:create-period  --fixture-id <id> --program <x> --name <x>
 *   pgm:enroll         --fixture-id <id> --program <x> --school <x> --section <x>
 *
 * Dedup strategy: programs by (organizationId, name); periods by
 * (programId, name); enrollment by (programId, schoolGroupId).
 *
 * Status: stubs. Lands under D3.1 step 3.
 */

import type { Command } from 'commander';

export function registerPgmCommands(program: Command): void {
  const pgm = program
    .command('pgm')
    .description('program-hub seed commands (create-program, create-period, enroll).');

  pgm
    .command('create-program')
    .description('Create a program (dedup by (org, name)).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--name <name>', 'program name')
    .requiredOption('--org <slug-or-uuid>', 'organization (district) slug or UUID')
    .option('--timezone <tz>', 'IANA timezone', 'America/Los_Angeles')
    .action(() => {
      console.error('pgm:create-program — not yet implemented (D3.1 step 3).');
      process.exitCode = 2;
    });

  pgm
    .command('create-period')
    .description('Create a period on a program (dedup by (program, name)).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--program <slug-or-uuid>', 'program')
    .requiredOption('--name <name>', 'period name')
    .option('--color-key <color>', 'color key', 'blue')
    .action(() => {
      console.error('pgm:create-period — not yet implemented (D3.1 step 3).');
      process.exitCode = 2;
    });

  pgm
    .command('enroll')
    .description('Set program enrollment (school + section, dedup by programId).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .requiredOption('--program <slug-or-uuid>', 'program')
    .requiredOption('--school <slug-or-uuid>', 'school group')
    .requiredOption('--section <slug-or-uuid>', 'section group (enrolled students)')
    .action(() => {
      console.error('pgm:enroll — not yet implemented (D3.1 step 3).');
      process.exitCode = 2;
    });
}
