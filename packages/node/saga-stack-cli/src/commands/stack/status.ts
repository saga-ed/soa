/**
 * `saga-stack stack status` — NATIVE manifest-derived health report (plan §2.4,
 * §7.2 "M2").
 *
 * RE-IMPLEMENTED in M2: instead of shelling out to `up.sh --status`, status now
 * derives its probe list straight from the MANIFEST (`core/probe-plan`) and GETs
 * each service's `<stack-lane>/<healthPath>` through the injectable HealthProber
 * (`this.getProber()`). Deriving the list from the manifest closes the gap that
 * verify.sh had (it hand-maintained ~10 endpoints and missed content-api
 * `:3009/health`); here content-api is covered automatically because it is in
 * the manifest.
 *
 * SCOPE: `--only <svc,…>` scopes the report to a dependency closure (so you can
 * status just the subset you brought up); `--with-playback` adds the optional
 * playback services. With neither, status probes every NON-optional service.
 *
 * READ-ONLY: status never exits non-zero on its own — a down service is REPORTED
 * (and reflected in the JSON `healthy` field / exit-free text), not raised as an
 * error of the command. The injectable prober NEVER throws (a down endpoint is
 * `{ ok:false }`), so the table always renders.
 *
 *   node bin/dev.js stack status
 *   node bin/dev.js stack status --only connect-web --output-json
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { computeClosure } from '../../core/closure.js';
import { healthProbes } from '../../core/probe-plan.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';

export default class StackStatus extends BaseCommand {
  static description =
    'Show per-service health, probing manifest-derived endpoints (native; read-only).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --only connect-web',
    '<%= config.bin %> <%= command.id %> --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'scope the health report to the dependency closure of these services (comma-list)',
    }),
    'with-playback': Flags.boolean({
      description: 'also probe the optional playback services (transcripts, insights, chat)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackStatus);

    const ids = resolveServiceSet(flags.only, flags['with-playback'], (msg) => this.error(msg));
    const probes = healthProbes(manifest, ids);

    const prober = this.getProber();
    const rows = await Promise.all(
      probes.map(async (probe) => {
        const result = await prober.probe(probe.url);
        return { ...probe, ok: result.ok, status: result.status };
      }),
    );

    const up = rows.filter((r) => r.ok).length;
    const down = rows.length - up;
    const healthy = down === 0;

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            services: rows.map((r) => ({
              id: r.id,
              url: r.url,
              ok: r.ok,
              status: r.status ?? null,
            })),
            summary: { total: rows.length, up, down },
            healthy,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (flags.porcelain) {
      for (const r of rows) this.log(`${r.id}=${r.ok ? 'up' : 'down'}`);
      this.log(`healthy=${healthy}`);
      return;
    }

    for (const r of rows) this.log(formatRow(r));
    this.log(`${up}/${rows.length} services up${healthy ? '' : ` (${down} down)`}`);
  }
}

/** A rendered probe row (probe + its outcome). */
interface StatusRow {
  id: ServiceId;
  url: string;
  ok: boolean;
  status?: number;
}

/** Human line: `✓ id   url   (200)` for up, `✗ id   url   (down)` for down. */
function formatRow(r: StatusRow): string {
  const mark = r.ok ? '✓' : '✗';
  const code = r.status !== undefined ? `(${r.status})` : '(down)';
  return `${mark} ${r.id.padEnd(16)} ${r.url}  ${code}`;
}

/**
 * Turn the `--only`/`--with-playback` flags into the ordered service-id list to
 * probe. `--only` ⇒ the dependency closure of the requested set (launch order);
 * otherwise every non-optional service (+ optional playback on `--with-playback`).
 * `fail` renders a friendly oclif error and does not return.
 */
export function resolveServiceSet(
  only: string | undefined,
  withPlayback: boolean,
  fail: (msg: string) => never,
): ServiceId[] {
  const requested = parseOnly(only);

  if (requested.length === 0) {
    return (Object.keys(manifest.services) as ServiceId[]).filter(
      (id) => withPlayback || !manifest.services[id].optional,
    );
  }

  const known = new Set(Object.keys(manifest.services));
  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    fail(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
  }

  return computeClosure(manifest, requested, { withPlayback }).services;
}

/** Split a `--only` comma list into trimmed, non-empty service ids. */
function parseOnly(only: string | undefined): ServiceId[] {
  if (!only) return [];
  return only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ServiceId[];
}
