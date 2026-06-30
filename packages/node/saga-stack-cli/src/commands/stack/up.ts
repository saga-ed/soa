/**
 * `saga-stack stack up` — bring the synthetic dev stack up.
 *
 * M0 implements ONLY the `--dry-run` planning path: parse `--only`, resolve the
 * dependency closure (`computeClosure`), and `emit()` it (services in launch
 * order, databases, mesh, and the reason each service is present). No docker /
 * pnpm / health IO happens here — the live launch loop lands in M1+.
 *
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run
 *
 * Imports come straight from the specific core modules (not the `core/index`
 * barrel) so this command stays decoupled from the seed/flow sub-barrels.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { computeClosure } from '../../core/closure.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';

export default class StackUp extends BaseCommand {
  static description =
    'Bring the synthetic dev stack up. M0 supports the --dry-run closure planner only.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api --dry-run',
    '<%= config.bin %> <%= command.id %> --dry-run --with-playback',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description: 'comma-separated services to bring up; closure pulls in their dependencies',
    }),
    'with-playback': Flags.boolean({
      description: 'include the optional playback services (transcripts, insights, chat)',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'plan only: print the resolved closure and exit without touching docker/pnpm',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackUp);

    if (!flags['dry-run']) {
      this.error('stack up: only --dry-run is implemented in M0 (live launch lands in M1+).');
    }

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
