/**
 * `saga-stack stack up` — bring the synthetic dev stack up.
 *
 * TWO PATHS:
 *  - `--dry-run` (M0): resolve the dependency closure (`computeClosure`) and
 *    `emit()` it (services in launch order, databases, mesh, and the reason each
 *    service is present). No docker / pnpm / health IO. NOTE this path honours
 *    the plan's NEW comma-list `--only` + closure semantics.
 *  - real (M1): a THIN WRAPPER. Map flags → `flagMap.up()` (the exact up.sh
 *    argv/env), then `runScript` shells out to the UNCHANGED `up.sh` with stdio
 *    inherited. Here `--only` is passed THROUGH to up.sh's single-service `--only`
 *    (up.sh self-validates and rejects a comma-list) — native partial-stack is M4.
 *
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run
 *   node bin/dev.js stack up --seed roster --login
 *
 * Imports come straight from the specific core modules (not the `core/index`
 * barrel) so this command stays decoupled from the seed/flow sub-barrels.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { computeClosure } from '../../core/closure.js';
import * as flagMap from '../../core/flag-map.js';
import type { RecordMode } from '../../core/flag-map.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import type { SeedProfile } from '../../core/seed/types.js';

export default class StackUp extends BaseCommand {
  static description =
    'Bring the synthetic dev stack up. Real run wraps up.sh; --dry-run prints the closure planner only.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api --dry-run',
    '<%= config.bin %> <%= command.id %> --dry-run --with-playback',
    '<%= config.bin %> <%= command.id %> --seed roster --login',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'services to bring up. With --dry-run, a comma-list whose dependency closure is printed. On a real run (M1) only a SINGLE service is accepted (passed through to up.sh); native comma-list + closure bring-up lands at M4.',
    }),
    'with-playback': Flags.boolean({
      description: 'include the optional playback services (transcripts, insights, chat)',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'plan only: print the resolved closure and exit without touching docker/pnpm',
      default: false,
    }),
    // ── up.sh trailing flags (real path only; ignored under --dry-run) ──
    reset: Flags.boolean({
      description: 'truncate + re-seed the data DBs before bringing services up (up.sh --reset)',
      default: false,
    }),
    seed: Flags.string({
      description:
        'seed the named profile after launch (up.sh --seed <profile>). A value is required in the wrapper; up.sh\'s bare `--seed` default is `roster`, so pass `--seed roster` for that behavior.',
      options: ['roster', 'full'],
    }),
    pull: Flags.boolean({
      description: 'force a full ff-only sync of every sibling repo before build (up.sh --pull)',
      default: false,
    }),
    'no-auto-pull': Flags.boolean({
      description: 'opt out of the automatic auto-pull pass (up.sh env NO_AUTO_PULL=1)',
      default: false,
    }),
    'skip-prep': Flags.boolean({
      description: 'skip the install+build prep pass (up.sh env SKIP_PREP=1)',
      default: false,
    }),
    record: Flags.string({
      description:
        'record session traffic (up.sh --record <mode>). A value is required in the wrapper; up.sh\'s bare `--record` default is `crdt`, so pass `--record crdt` for that behavior.',
      options: ['crdt', 'av'],
    }),
    'with-qtf-demo': Flags.boolean({
      description: 'include the QTF demo seed/services (up.sh --with-qtf-demo)',
      default: false,
    }),
    tunnel: Flags.boolean({
      description: 'open the public tunnel for the stack (up.sh --tunnel)',
      default: false,
    }),
    login: Flags.boolean({
      description:
        'log in the default persona (dev@saga.org) after launch (up.sh --login); use `stack login <email>` to override the persona',
      default: false,
    }),
    sandbox: Flags.string({
      description: 'named sandbox to launch into (up.sh --sandbox <name>; accompanies --only)',
    }),
    workspace: Flags.string({
      description: 'workspace file to launch from (up.sh --workspace <file.json>)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackUp);

    // ── Real path (M1): thin wrapper over up.sh. ──
    if (!flags['dry-run']) {
      // up.sh's `--only` accepts a SINGLE known service and exits 1 on a
      // comma-list. Reject it here with a milestone-aware message rather than
      // letting up.sh emit a generic "unknown service" error. Comma-list +
      // dependency closure is native partial-stack work (M4); preview it today
      // with --dry-run.
      if (flags.only?.includes(',')) {
        this.error(
          'comma-separated --only (dependency closure) is only available with --dry-run until native partial-stack lands (M4). A real run accepts a single service; re-run with --dry-run to preview the closure.',
        );
      }
      const plan = flagMap.up({
        reset: flags.reset,
        seed: flags.seed as SeedProfile | undefined,
        pull: flags.pull,
        noAutoPull: flags['no-auto-pull'],
        skipPrep: flags['skip-prep'],
        record: flags.record as RecordMode | undefined,
        withPlayback: flags['with-playback'],
        withQtfDemo: flags['with-qtf-demo'],
        tunnel: flags.tunnel,
        login: flags.login,
        only: flags.only,
        sandbox: flags.sandbox,
        workspace: flags.workspace,
      });
      await this.runScript(plan, flags);
      return;
    }

    // ── Dry-run path (M0): closure planner. ──
    // Parse --only into a requested set; absent/empty ⇒ the full (non-optional)
    // stack, with playback added only on --with-playback.
    const requested: ServiceId[] = parseOnly(flags.only);
    const resolvedRequest: ServiceId[] =
      requested.length > 0
        ? requested
        : Object.values(manifest.services)
            .filter((s) => flags['with-playback'] || !s.optional)
            .map((s) => s.id);

    // Friendly validation before the closure engine throws.
    const known = new Set(Object.keys(manifest.services));
    const unknown = resolvedRequest.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.error(
        `unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`,
      );
    }

    const closure = computeClosure(manifest, resolvedRequest, {
      withPlayback: flags['with-playback'],
    });

    const reasonsObj: Record<string, string[]> = {};
    for (const svc of closure.services) reasonsObj[svc] = closure.reasons.get(svc) ?? [];

    const json: Record<string, unknown> = {
      dryRun: true,
      requested: resolvedRequest,
      services: closure.services,
      databases: closure.databases,
      mesh: closure.mesh,
      reasons: reasonsObj,
    };

    const textLines: string[] = [
      `dry-run closure for: ${resolvedRequest.join(', ')}`,
      `services (launch order): ${closure.services.join(' -> ') || '(none)'}`,
      `databases: ${closure.databases.join(', ') || '(none)'}`,
      `mesh: ${closure.mesh.join(', ') || '(none)'}`,
      'reasons:',
      ...closure.services.map((svc) => `  ${svc}: ${(closure.reasons.get(svc) ?? []).join('; ')}`),
    ];

    this.emit(flags, json, textLines);
  }
}

/** Split a `--only` comma list into trimmed, non-empty service ids. */
function parseOnly(only: string | undefined): ServiceId[] {
  if (!only) return [];
  return only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ServiceId[];
}
