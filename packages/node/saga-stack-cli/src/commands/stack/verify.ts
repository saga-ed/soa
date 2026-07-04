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
import { BUNDLE_NAMES } from '../../core/bundles.js';
import { deriveInstance } from '../../core/derive-instance.js';
import * as flagMap from '../../core/flag-map.js';
import { healthProbes } from '../../core/probe-plan.js';
import { getMesh, manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { DATA_SQL, assessData } from '../../core/verify-data.js';
import type { DataReadings } from '../../core/verify-data.js';
import { meshContainer } from '../../runtime/index.js';
import { partitionByRepoPresence, repoContextFromFlags, resolveServiceSet } from './status.js';

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
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) to include — sugar over --only (unions the bundle's services into the closure). Repeatable/composable: --with dash --with coach. Bundles: dash, connect, coach, playback.",
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

  /** M7 Phase 2: the native health gate probes a slot's offset ports at slot > 0. */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackVerify);

    // ── --full: native health + native DATA (D1–D5) + DELEGATED source-posture. ──
    // M9: the DATA half is no longer delegated — `stack verify --full` runs D1–D5
    // NATIVELY and hard-fails on an unseeded/unmigrated/mongo-unreachable stack. The
    // source-posture (P1–P4) checks stay delegated to verify.sh (M12); verify.sh
    // re-runs its own health/data before posture (a documented redundancy the M12 port
    // removes), but the native hard-fail here is the authoritative DATA gate.
    if (flags.full) {
      if (flags.only) {
        this.warn('--only is ignored with --full (the DATA checks + verify.sh cover the whole stack).');
      }
      await this.runFull(flags);
      return;
    }

    // ── Native health gate (scoped to the --only closure, else all required). ──
    const tolerate = parseTolerate(flags.tolerate);
    // M7: the slot profile drives the offset probe ports + the slot>0 exclusion.
    // At slot 0 it's the byte-identical no-offset default (base ports, no exclusion).
    const profile = deriveInstance({ slot: flags.slot });
    let ids = resolveServiceSet(flags.only, flags.with, (m) => this.error(m));
    // At slot > 0 the literal-port services aren't brought up (see `stack up`), so
    // don't gate on them here either — they'd always read down.
    if (profile.slot > 0) {
      const excluded = new Set(profile.excludedServices);
      ids = ids.filter((id) => !excluded.has(id));
    }

    // A service whose sibling repo isn't cloned is reported not-cloned (NOT a
    // failure) — a missing coach checkout must not fail the gate, matching `stack
    // up`'s skip guard.
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const { probe, notCloned } = partitionByRepoPresence(ids, ctx, this.getRepoDirCheck());
    const probes = healthProbes(manifest, probe, profile.portOverrides);

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
            notCloned: notCloned.map((n) => ({ id: n.id, repo: n.repo, repoDir: n.repoDir })),
            summary: { total: rows.length, up, failed: failures.length, notCloned: notCloned.length },
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
      for (const n of notCloned) this.log(`${n.id}=not-cloned`);
      this.log(`passed=${passed}`);
    } else {
      for (const r of rows) this.log(formatRow(r));
      for (const n of notCloned) {
        this.log(`⚠ ${n.id.padEnd(16)} ${n.repoDir}  (not cloned: ${n.repo} repo not present)`);
      }
      this.log(
        passed
          ? `verify: PASS — ${up}/${rows.length} required services up` +
              (notCloned.length ? ` (${notCloned.length} not cloned)` : '')
          : `verify: FAIL — ${failures.length} required service(s) down: ${failures.map((f) => f.id).join(', ')}`,
      );
    }

    // Native health gate is the exit code: non-zero iff a non-tolerated required
    // service is down. (--full runs the DATA gate + delegates posture above.)
    if (!passed) this.exit(1);
  }

  /**
   * `--full`: native health gate over ALL required services + native DATA (D1–D5) +
   * delegated source-posture. Hard-fails (exit 1) on any down required service, any
   * failed DATA check, OR a non-zero verify.sh (posture). `users != 205` is a NOTE.
   *
   * SLOT: `--full` is slot-0 only (verify.sh is hardcoded to slot 0, and the DATA
   * probes read the base `soa-*` mesh containers) — refuse at slot > 0.
   */
  private async runFull(flags: {
    slot: number;
    porcelain: boolean;
    'output-json': boolean;
    'health-only': boolean;
    dev: string;
    soa?: string;
  }): Promise<void> {
    if (flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: verify --full reads the base slot-0 mesh + delegates to verify.sh ` +
          '(hardcoded to slot 0). Use a plain `stack verify --slot N` for the native health gate.',
      );
    }

    // 1. native health gate over every required (non-optional) service.
    const ids = Object.values(manifest.services)
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const prober = this.getProber();
    const healthRows = await Promise.all(
      healthProbes(manifest, ids).map(async (p) => {
        const r = await prober.probe(p.url);
        return { id: p.id, url: p.url, ok: r.ok, status: r.status };
      }),
    );
    const healthDown = healthRows.filter((r) => !r.ok);
    this.log('── service health ──');
    for (const r of healthRows) {
      this.log(`${r.ok ? '✓' : '✗'} ${r.id.padEnd(16)} ${r.url}  (${r.status ?? 'down'})`);
    }

    // 2. native DATA checks (D1–D5). Reads as postgres_admin against the base mesh
    // containers (documented divergence from verify.sh's `-U iam` — same rows).
    const pg = this.getPgProbe();
    const meshExec = this.getMeshExec();
    const pgContainer = meshContainer(getMesh('postgres', manifest));
    const mongo = getMesh('connect-mongo', manifest);
    const mongoContainer = meshContainer(mongo);
    const readings: DataReadings = {
      usersRaw: await pg.scalar(pgContainer, 'iam_local', DATA_SQL.users),
      devIdRaw: await pg.scalar(pgContainer, 'iam_local', DATA_SQL.devId),
      adminPersonasRaw: await pg.scalar(pgContainer, 'iam_local', DATA_SQL.adminPersonas),
      sisMigrated: await pg.hasMigrationsTable(pgContainer, 'sis_db'),
      mongoReachable: await meshExec.ready(mongoContainer, mongo.readinessCmd),
    };
    const data = assessData(readings);
    this.log('── data ──');
    for (const c of data.checks) this.log(`${c.ok ? '✓' : '✗'} ${c.label}`);
    for (const note of data.notes) this.log(`· ${note}`);

    // 3. DELEGATED source-posture (P1–P4) — verify.sh remains canonical for posture
    // (M12). Its exit reflects its own health/data re-check + posture badlines; captured
    // (not propagated) so we can fold it with the native gates.
    const plan = flagMap.verify({ healthOnly: flags['health-only'] });
    const postureCode = await this.runScript(plan, flags, { propagateExit: false });

    // Combined verdict: native health, native DATA, and posture must all pass.
    const healthOk = healthDown.length === 0;
    this.log(
      healthOk && data.passed && postureCode === 0
        ? '✓ verify --full: health + data + posture all green'
        : `✗ verify --full: ${[
            healthOk ? null : `${healthDown.length} service(s) down`,
            data.passed ? null : `${data.checks.filter((c) => !c.ok).length} data check(s) failed`,
            postureCode === 0 ? null : 'source-posture failed',
          ]
            .filter(Boolean)
            .join('; ')}`,
    );
    if (!(healthOk && data.passed && postureCode === 0)) this.exit(1);
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
