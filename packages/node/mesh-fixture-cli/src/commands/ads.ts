/**
 * ads:* — SDS ads-adm-api seed commands.
 *
 * Planned:
 *   ads:seed-attendance --fixture-id <id> --csv <path>
 *
 * Deferred pending coordination with SDS PR #77 ("retire in-app mocks;
 * seed postgres from CSVs"). Per plan appendix A.5 D3.1: "If Seth's CSV
 * seed produces the same data shape, the mesh command can wrap it rather
 * than reinvent." Talk to Seth before authoring.
 *
 * See ../coordination/seth-77-alignment.md.
 */

import type { Command } from 'commander';

export function registerAdsCommands(program: Command): void {
  const ads = program
    .command('ads')
    .description('SDS ads-adm-api seed commands (deferred pending #77 coordination).');

  ads
    .command('seed-attendance')
    .description('Seed attendance rows for a demo program × date (deferred).')
    .requiredOption('--fixture-id <id>', 'fixture identifier')
    .option('--csv <path>', 'CSV path (format TBD pending #77)')
    .action(() => {
      console.error(
        'ads:seed-attendance — deferred pending Seth PR #77 coordination (plan A.5).',
      );
      process.exitCode = 2;
    });
}
