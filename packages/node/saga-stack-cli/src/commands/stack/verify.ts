/**
 * `saga-stack stack verify` — NATIVE manifest-derived health gate (plan §2.4,
 * §7.2 "M2").
 *
 * RE-IMPLEMENTED in M2. The health gate is now native: verify derives its probe
 * list from the MANIFEST (`core/probe-plan` — every NON-optional service, which
 * is exactly the "required" set) and GETs each endpoint through the injectable
 * HealthProber (`this.getProber()`). Because the list comes from the manifest it
 * covers content-api `:3009/health` — the endpoint the hand-maintained verify.sh
 * list missed (plan §2.4).
 *
 *   - default / `--health-only`  native health gate. Exit NON-ZERO if any
 *     required service is down. (Native health IS the default; `--health-only`
 *     is the explicit name for it, and on `--full` it scopes the delegated run.)
 *   - `--tolerate <repo,…>`      a tolerated service being down does NOT fail the
 *     gate (it is reported as "down (tolerated)"). Now possible because verify is
 *     native — verify.sh took no argv. A token matches a service by id OR by its
 *     repo name (e.g. `--tolerate saga-dash` tolerates the saga-dash service).
 *   - `--full`                   DELEGATE to verify.sh via the Runner for the
 *     DEEP data + git-posture checks the native gate does not yet cover. `--full`
 *     is the CANONICAL complete check until those port natively (a later
 *     milestone); `--health-only` narrows the delegated verify.sh to its health
 *     gate (env VERIFY_HEALTH_ONLY=1).
 *
 *   node bin/dev.js stack verify
 *   node bin/dev.js stack verify --tolerate saga-dash
 *   node bin/dev.js stack verify --full
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import { healthProbes } from '../../core/probe-plan.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { resolveServiceSet } from './status.js';

export default class StackVerify extends BaseCommand {
  static description =
    'Verify the stack: native manifest-derived health gate (--full delegates the deep checks to verify.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api',
    '<%= config.bin %> <%= command.id %> --tolerate saga-dash',
    '<%= config.bin %> <%= command.id %> --full',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'scope the NATIVE health gate to the dependency closure of these services (comma-list) — so a partial `stack up --only …` verifies just what it launched, instead of failing on the services it never started. Ignored with --full (verify.sh checks the whole stack).',
    }),
    'with-playback': Flags.boolean({
      description: 'also gate on the optional playback services (transcripts, insights, chat)',
      default: false,
    }),
    'health-only': Flags.boolean({
      description:
        'native health gate only (the default). On --full, narrows the delegated verify.sh to its health gate (VERIFY_HEALTH_ONLY=1).',
      default: false,
    }),
    tolerate: Flags.string({
      description:
        'tolerate these services being down without failing the gate (comma-list; matches a service id or its repo name, e.g. saga-dash)',
      multiple: true,
    }),
    full: Flags.boolean({
      description:
        'run the CANONICAL complete check: delegate the deep data + git-posture checks to verify.sh (the native gate only covers health today).',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackVerify);

    // ── --full: delegate the deep checks to the still-canonical verify.sh. ──
    if (flags.full) {
      if (flags.only) {
        this.warn('--only is ignored with --full (verify.sh checks the whole stack).');
      }
      const plan = flagMap.verify({ healthOnly: flags['health-only'] });
      await this.runScript(plan, flags); // propagates verify.sh's exit code verbatim
      return;
    }

    // ── Native health gate (scoped to the --only closure, else all required). ──
    const tolerate = parseTolerate(flags.tolerate);
    const ids = resolveServiceSet(flags.only, flags['with-playback'], (m) => this.error(m));
    const probes = healthProbes(manifest, ids);

    const prober = this.getProber();
    const rows = await Promise.all(
      probes.map(async (probe) => {
        const result = await prober.probe(probe.url);
        return {
          id: probe.id,
          url: probe.url,
          ok: result.ok,
          status: result.status,
          tolerated: !result.ok && isTolerated(probe.id, tolerate),
        };
      }),
    );

    const failures = rows.filter((r) => !r.ok && !r.tolerated);
    const up = rows.filter((r) => r.ok).length;
    const passed = failures.length === 0;

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            services: rows.map((r) => ({
              id: r.id,
              url: r.url,
              ok: r.ok,
              status: r.status ?? null,
              tolerated: r.tolerated,
            })),
            summary: { total: rows.length, up, failed: failures.length },
            passed,
          },
          null,
          2,
        ),
      );
    } else if (flags.porcelain) {
      for (const r of rows) {
        this.log(`${r.id}=${r.ok ? 'up' : r.tolerated ? 'down-tolerated' : 'down'}`);
      }
      this.log(`passed=${passed}`);
    } else {
      for (const r of rows) this.log(formatRow(r));
      this.log(
        passed
          ? `verify: PASS — ${up}/${rows.length} required services up`
          : `verify: FAIL — ${failures.length} required service(s) down: ${failures.map((f) => f.id).join(', ')}`,
      );
    }

    // Native health gate is the exit code: non-zero iff a non-tolerated required
    // service is down. (--full delegates the exit code to verify.sh above.)
    if (!passed) this.exit(1);
  }
}

/** A rendered verify row. */
interface VerifyRow {
  id: ServiceId;
  url: string;
  ok: boolean;
  status?: number;
  tolerated: boolean;
}

/** Human line, with a `(tolerated)` annotation for a down-but-tolerated service. */
function formatRow(r: VerifyRow): string {
  const mark = r.ok ? '✓' : r.tolerated ? '⚠' : '✗';
  const code = r.status !== undefined ? `(${r.status})` : r.tolerated ? '(down, tolerated)' : '(down)';
  return `${mark} ${r.id.padEnd(16)} ${r.url}  ${code}`;
}

/**
 * Flatten the (repeatable) `--tolerate` flag into a token set, also splitting
 * comma-lists so `--tolerate saga-dash,rtsm-api` and `--tolerate saga-dash
 * --tolerate rtsm-api` are equivalent.
 */
export function parseTolerate(tolerate: string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const entry of tolerate ?? []) {
    for (const tok of entry.split(',').map((s) => s.trim()).filter(Boolean)) set.add(tok);
  }
  return set;
}

/**
 * A service is tolerated when a tolerate token matches its id, or its repo name
 * in any spelling (`SAGA_DASH`, the kebab `saga-dash`). Matching by repo lets a
 * single token tolerate a whole repo's services.
 */
export function isTolerated(id: ServiceId, tolerate: Set<string>): boolean {
  if (tolerate.has(id)) return true;
  const repo = manifest.services[id].repo; // e.g. 'SAGA_DASH'
  return tolerate.has(repo) || tolerate.has(repo.toLowerCase().replace(/_/g, '-'));
}
