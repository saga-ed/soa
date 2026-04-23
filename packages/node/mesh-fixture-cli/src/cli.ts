/**
 * mesh-fixture — CLI entry point.
 *
 * Top-level dispatcher for the cross-repo fixture authoring + snapshot
 * lifecycle on the saga-mesh (rostering + program-hub + SDS). See the
 * package README for the full command surface and current status.
 *
 * Command namespaces:
 *   fixture:*  — snapshot lifecycle (list, store, restore, delete)
 *   iam:*      — rostering iam-api seed commands (create-org, create-user,
 *                add-membership). tRPC-driven, dedups by natural key.
 *   pgm:*      — program-hub seed commands (create-program, create-period,
 *                enroll).
 *   ads:*      — SDS ads-adm-api seed commands (seed-attendance).
 *                Deferred pending coordination on SDS PR #77.
 *
 * This is the Phase 3 scaffold. Most commands are stubs — the first
 * end-to-end path is fixture:list + fixture:store + fixture:restore.
 *
 * Tracking: saga-ed/student-data-system#80 Phase 3.
 */

import { Command } from 'commander';
import { registerFixtureCommands } from './commands/fixture.js';
import { registerIamCommands } from './commands/iam.js';
import { registerPgmCommands } from './commands/pgm.js';
import { registerAdsCommands } from './commands/ads.js';

const program = new Command();

program
  .name('mesh-fixture')
  .description(
    'Saga-mesh fixture CLI — author + snapshot cross-repo test data (rostering + program-hub + SDS).',
  )
  .version('0.0.1');

// Shared flags usable across any command. Subcommands read these from the
// global options via `program.opts()` or `cmd.optsWithGlobals()`.
program
  .option('--porcelain', 'machine-readable output; no color, minimal noise', false)
  .option('--output-json', 'emit structured JSON on stdout instead of human-readable text', false)
  .option(
    '--iam-url <url>',
    'override rostering iam-api base URL (default: http://localhost:3000)',
    process.env.IAM_API_URL ?? 'http://localhost:3000',
  )
  .option(
    '--programs-url <url>',
    'override program-hub programs-api base URL (default: http://localhost:3006)',
    process.env.PROGRAMS_API_URL ?? 'http://localhost:3006',
  )
  .option(
    '--ads-adm-url <url>',
    'override SDS ads-adm-api base URL (default: http://localhost:5005)',
    process.env.ADS_ADM_URL ?? 'http://localhost:5005',
  );

registerFixtureCommands(program);
registerIamCommands(program);
registerPgmCommands(program);
registerAdsCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`mesh-fixture: ${msg}`);
  process.exitCode = 1;
});
