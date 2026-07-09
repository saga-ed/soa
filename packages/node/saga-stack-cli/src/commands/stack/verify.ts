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

import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { bold, cyan, dim, green, red, yellow } from '../../color.js';
import { BUNDLE_NAMES } from '../../core/bundles.js';
import { INSTANCE_ENV_KEYS, deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import { SYNTH_DEV_DIR } from '../../core/flag-map.js';
import { healthProbes } from '../../core/probe-plan.js';
import { getMesh, manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { DATA_SQL, assessData } from '../../core/verify-data.js';
import type { DataAssessment, DataReadings } from '../../core/verify-data.js';
import { parseOverlayTsv } from '../../core/overlay-tsv.js';
import type { PostureLine } from '../../core/verify-posture.js';
import { assessPosture, meshContainer, resolveOverlayRepo, resolveRepoRoot } from '../../runtime/index.js';
import type { ScriptContext } from '../../runtime/index.js';
import { partitionByRepoPresence, repoContextFromFlags, resolveServiceSet } from './status.js';

export default class StackVerify extends BaseCommand {
  static description =
    'Verify the stack: native manifest-derived health gate (--full adds the native DATA + posture checks).';

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
        'run the CANONICAL complete check FULLY NATIVELY: native health gate + native DATA (D1–D5) + native source-posture (P1–P4). --health-only skips the posture/freshness pass.',
      default: false,
    }),
    'all-slots': Flags.boolean({
      description:
        'report EVERY active slot (0..9) instead of a single --slot. A slot is active when its state dir holds a live service pid or its soa-s<N> compose project has running containers (the `ss set list` ACTIVE probe). Each slot gets its own health section (offset ports); with --full each also gets its own DATA section read against THAT slot’s soa-s<N> mesh, and the shared source-posture runs ONCE. Cannot be combined with --slot N>0 or --set (those target one slot). --only/--with are ignored.',
      default: false,
    }),
  };

  /** M7 Phase 2: the native health gate probes a slot's offset ports at slot > 0. */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `--set` verifies the set's slot with the set's repo pins. */
  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackVerify);

    // ── --all-slots: report EVERY active slot (0..9), not a single --slot. ──
    if (flags['all-slots']) {
      if (flags.set) {
        this.error('--all-slots enumerates every active slot; drop --set (a set is bound to one slot).');
      }
      if (flags.slot > 0) {
        this.error('--all-slots enumerates every active slot; drop --slot (it targets one slot).');
      }
      await this.runAllSlots(flags);
      return;
    }

    // ── --full: FULLY NATIVE — native health + native DATA (D1–D5) + native posture. ──
    // M12: the source-posture (P1–P4) checks are now NATIVE too (warn-only), so `stack
    // verify --full` no longer delegates ANYTHING to verify.sh. The verdict is driven by
    // health + DATA alone; posture emits warnings/notes that NEVER flip the exit code.
    if (flags.full) {
      if (flags.only) {
        this.warn('--only is ignored with --full (the native DATA + posture checks cover the whole stack).');
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
   * `--full`: FULLY NATIVE — native health gate over ALL required services + native DATA
   * (D1–D5) + native source-posture (P1–P4). Hard-fails (exit 1) ONLY on a down required
   * service or a failed DATA check. `users != 205` is a NOTE. The posture pass is STRICTLY
   * WARN-ONLY: it emits `✓`/`⚠`/`·` lines but NEVER contributes to the exit code (a wrong
   * branch, an unmerged pin, an unpinned overlay, or a behind-origin repo is a warning, not
   * a failure). Nothing is delegated to verify.sh.
   *
   * `--health-only` skips the posture/freshness pass (health + DATA only) — the native
   * equivalent of the old VERIFY_HEALTH_ONLY=1 delegation.
   *
   * SLOT: `--full` is slot-0 only (the DATA probes read the base `soa-*` mesh containers,
   * and posture reads the default checkouts) — refuse at slot > 0.
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
        `slot ${flags.slot}: verify --full reads the base slot-0 mesh + postures the default ` +
          'checkouts. Use a plain `stack verify --slot N` for the native health gate.',
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
    this.log(cyan(bold('── service health ──')));
    for (const r of healthRows) {
      this.log(
        `${r.ok ? green('✓') : red('✗')} ${r.id.padEnd(16)} ${dim(r.url)}  (${r.ok ? green(String(r.status ?? '')) : red('down')})`,
      );
    }

    // 2. native DATA checks (D1–D5). Reads as postgres_admin against the base mesh
    // containers (documented divergence from verify.sh's `-U iam` — same rows).
    const data = await this.readSlotData();
    this.log(cyan(bold('── data ──')));
    for (const c of data.checks) this.log(`${c.ok ? green('✓') : red('✗')} ${dim(c.label)}`);
    for (const note of data.notes) this.log(dim(`· ${note}`));

    // 3. NATIVE source-posture (P1–P4) — STRICTLY WARN-ONLY (M12). Emits ✓/⚠/· lines but
    // NEVER contributes to the verdict. Skipped under --health-only (health + DATA only).
    let postureWarns = 0;
    if (!flags['health-only']) {
      const posture = await this.runPosture(flags);
      this.log(cyan(bold('── source posture ──')));
      if (!posture.overlayPresent) {
        this.log(dim('· no local overlay — asserting every managed repo on origin/main'));
      }
      for (const l of posture.result.posture) this.log(renderPostureLine(l));
      this.log(cyan(bold('── freshness (behind origin) ──')));
      for (const l of posture.result.freshness) this.log(renderPostureLine(l));
      postureWarns = [...posture.result.posture, ...posture.result.freshness].filter(
        (l) => l.level === 'warn',
      ).length;
    }

    // Combined verdict: native health + native DATA ONLY. Posture warnings are surfaced
    // (a trailing count) but CANNOT flip the exit code — the M12 warn-only invariant.
    const healthOk = healthDown.length === 0;
    const passed = healthOk && data.passed;
    const warnSuffix = postureWarns > 0 ? ` (${postureWarns} posture warning(s) — see ⚠ above)` : '';
    this.log(
      passed
        ? green(bold(`✓ verify --full: health + data green`)) + (warnSuffix ? yellow(warnSuffix) : '')
        : red(bold(`✗ verify --full: ${[
            healthOk ? null : `${healthDown.length} service(s) down`,
            data.passed ? null : `${data.checks.filter((c) => !c.ok).length} data check(s) failed`,
          ]
            .filter(Boolean)
            .join('; ')}`)) + (warnSuffix ? yellow(warnSuffix) : ''),
    );
    if (!passed) this.exit(1);
  }

  /**
   * `--all-slots`: report EVERY active slot (0..9) instead of a single `--slot`. A
   * slot is ACTIVE per the shared `SlotActiveProbe` (a live service pid under its
   * state dir OR a running `soa`/`soa-s<N>` compose project — the same probe `ss set
   * list` uses). Each active slot gets its own health gate on its offset ports; under
   * `--full` each ALSO gets its own DATA gate read against THAT slot's `soa-s<N>` mesh
   * (via `withSlotEnv`), and the SHARED source-posture runs ONCE (warn-only). Exit 1
   * iff any active slot's health (+ data) is red — posture never flips the verdict.
   */
  private async runAllSlots(flags: AllSlotsFlags): Promise<void> {
    if (flags.only || (flags.with && flags.with.length > 0)) {
      this.warn('--only/--with are ignored with --all-slots (each active slot is verified over its full required set).');
    }

    const probe = this.getSlotActiveProbe();
    const profiles = Array.from({ length: 10 }, (_, slot) => deriveInstance({ slot }));
    const activity = await Promise.all(
      profiles.map(async (p) => ({ profile: p, active: await probe.isActive(p.stateDir, p.project) })),
    );
    const active = activity.filter((a) => a.active).map((a) => a.profile);

    if (active.length === 0) {
      if (flags['output-json']) {
        this.log(JSON.stringify({ slots: [], activeSlots: [], passed: true }, null, 2));
      } else if (flags.porcelain) {
        this.log('activeSlots=');
        this.log('passed=true');
      } else {
        this.log(
          yellow('verify --all-slots: no active slots — none have a live service pid or a running soa[-s<N>] project.'),
        );
      }
      return; // nothing up ⇒ nothing to fail ⇒ exit 0.
    }

    // Gathered SEQUENTIALLY: the --full DATA read mutates process.env (per-slot mesh
    // container selection via withSlotEnv), so slots must not overlap.
    const reports: SlotReport[] = [];
    for (const profile of active) reports.push(await this.checkSlot(flags, profile));

    // Source posture is a property of the SHARED checkouts, not any one slot — run it
    // ONCE (warn-only, --full only, skipped under --health-only), like single-slot --full.
    let posture: Awaited<ReturnType<StackVerify['runPosture']>> | undefined;
    let postureWarns = 0;
    if (flags.full && !flags['health-only']) {
      posture = await this.runPosture(flags);
      postureWarns = [...posture.result.posture, ...posture.result.freshness].filter(
        (l) => l.level === 'warn',
      ).length;
    }

    const passed = reports.every((r) => r.passed);

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            slots: reports.map((r) => ({
              slot: r.slot,
              project: r.project,
              services: r.rows.map((row) => ({ id: row.id, url: row.url, ok: row.ok, status: row.status ?? null })),
              notCloned: r.notCloned.map((n) => ({ id: n.id, repo: n.repo, repoDir: n.repoDir })),
              data: r.data ? { checks: r.data.checks, notes: r.data.notes, passed: r.data.passed } : null,
              summary: { total: r.rows.length, up: r.up, down: r.rows.length - r.up },
              passed: r.passed,
            })),
            posture: posture
              ? {
                  overlayPresent: posture.overlayPresent,
                  warnings: postureWarns,
                  posture: posture.result.posture,
                  freshness: posture.result.freshness,
                }
              : null,
            activeSlots: active.map((p) => p.slot),
            passed,
          },
          null,
          2,
        ),
      );
    } else if (flags.porcelain) {
      for (const r of reports) {
        for (const row of r.rows) this.log(`s${r.slot}.${row.id}=${row.ok ? 'up' : 'down'}`);
        for (const n of r.notCloned) this.log(`s${r.slot}.${n.id}=not-cloned`);
        if (r.data) for (const c of r.data.checks) this.log(`s${r.slot}.${c.id}=${c.ok ? 'ok' : 'fail'}`);
        this.log(`s${r.slot}.passed=${r.passed}`);
      }
      this.log(`activeSlots=${active.map((p) => p.slot).join(',')}`);
      this.log(`passed=${passed}`);
    } else {
      for (const r of reports) {
        this.log(
          cyan(bold(`── slot ${r.slot} (${r.project}) — ${r.passed ? green('green') : red('red')} — ${r.up}/${r.rows.length} up ──`)),
        );
        for (const row of r.rows) this.log(formatRow(row));
        for (const n of r.notCloned) {
          this.log(`⚠ ${n.id.padEnd(16)} ${n.repoDir}  (not cloned: ${n.repo} repo not present)`);
        }
        if (r.data) {
          for (const c of r.data.checks) this.log(`  ${c.ok ? green('✓') : red('✗')} ${dim(c.label)}`);
          for (const note of r.data.notes) this.log(dim(`  · ${note}`));
        }
      }
      if (posture) {
        this.log(cyan(bold('── source posture (shared checkouts) ──')));
        if (!posture.overlayPresent) {
          this.log(dim('· no local overlay — asserting every managed repo on origin/main'));
        }
        for (const l of posture.result.posture) this.log(renderPostureLine(l));
        this.log(cyan(bold('── freshness (behind origin) ──')));
        for (const l of posture.result.freshness) this.log(renderPostureLine(l));
      }
      const failed = reports.filter((r) => !r.passed);
      const warnSuffix = postureWarns > 0 ? yellow(` (${postureWarns} posture warning(s) — see ⚠ above)`) : '';
      this.log(
        passed
          ? green(bold(`✓ verify --all-slots: ${reports.length}/${reports.length} active slot(s) green`)) + warnSuffix
          : red(
              bold(
                `✗ verify --all-slots: ${failed.length}/${reports.length} active slot(s) failing — slot(s) ${failed
                  .map((r) => r.slot)
                  .join(', ')}`,
              ),
            ) + warnSuffix,
      );
    }

    if (!passed) this.exit(1);
  }

  /**
   * Health-gate one slot: probe its full required (non-optional) service set on that
   * slot's offset ports, dropping the slot's excluded literal-port services at slot > 0
   * (they aren't brought up there). A service whose sibling repo isn't cloned is reported
   * not-cloned, not failed — matching `stack up`'s skip guard.
   */
  private async probeSlotHealth(
    flags: AllSlotsFlags,
    profile: InstanceProfile,
  ): Promise<{ rows: VerifyRow[]; notCloned: ReturnType<typeof partitionByRepoPresence>['notCloned'] }> {
    const excluded = new Set(profile.excludedServices);
    let ids = Object.values(manifest.services)
      .filter((s) => !s.optional)
      .map((s) => s.id);
    if (profile.slot > 0) ids = ids.filter((id) => !excluded.has(id));

    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const { probe, notCloned } = partitionByRepoPresence(ids, ctx, this.getRepoDirCheck());
    const probes = healthProbes(manifest, probe, profile.portOverrides);
    const prober = this.getProber();
    const rows = await Promise.all(
      probes.map(async (p): Promise<VerifyRow> => {
        const r = await prober.probe(p.url);
        return { id: p.id, url: p.url, ok: r.ok, status: r.status, tolerated: false };
      }),
    );
    return { rows, notCloned };
  }

  /** Health (+ DATA under --full) for one slot, folded into a pass/fail `SlotReport`. */
  private async checkSlot(flags: AllSlotsFlags, profile: InstanceProfile): Promise<SlotReport> {
    const { rows, notCloned } = await this.probeSlotHealth(flags, profile);
    const up = rows.filter((r) => r.ok).length;
    const data = flags.full ? await this.withSlotEnv(profile, () => this.readSlotData()) : undefined;
    const passed = up === rows.length && (!data || data.passed);
    return { slot: profile.slot, project: profile.project, rows, notCloned, data, up, passed };
  }

  /**
   * Gather + assess the native DATA checks (D1–D5) against the mesh containers CURRENTLY
   * selected by `process.env` (`SAGA_MESH_*_CONTAINER`). At slot 0 those resolve to the base
   * `soa-*` containers; under `--all-slots` the caller wraps this in `withSlotEnv` so it hits
   * that slot's `soa-s<N>-*` mesh. IO-only (the pg/mesh seams); the pure verdict is `assessData`.
   */
  private async readSlotData(): Promise<DataAssessment> {
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
    return assessData(readings);
  }

  /**
   * Run `fn` with ONLY this slot's mesh/snapshot env applied, restoring the prior values
   * afterwards — so an all-slots sweep reads each slot's OWN `soa-s<N>-*` containers without
   * leaking one slot's `SAGA_MESH_*_CONTAINER` into the next. Slot 0 carries an empty
   * container env, so `applyInstanceEnv` alone would NOT clear a prior slot's keys; we
   * snapshot + delete the fixed `INSTANCE_ENV_KEYS` set first, then restore in a `finally`.
   */
  private async withSlotEnv<T>(profile: InstanceProfile, fn: () => Promise<T>): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const k of INSTANCE_ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    this.applyInstanceEnv(profile);
    try {
      return await fn();
    } finally {
      for (const k of INSTANCE_ENV_KEYS) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  /**
   * Gather + assess the native source-posture (P1–P4) for `--full`. Reads the personal
   * overlay tsv through the injectable fs seam, parses its pins, resolves each managed /
   * always-main repo's checkout path (honouring --<repo>/$<REPO>/--dev, a native
   * improvement over verify.sh's hardcoded $DEV/<name>), and drives the git/gh seams via
   * `assessPosture`. Purely warn-only — the result never gates verify.
   */
  private async runPosture(flags: { dev: string; soa?: string }): Promise<{
    overlayPresent: boolean;
    result: Awaited<ReturnType<typeof assessPosture>>;
  }> {
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const manifestPath = join(resolveRepoRoot('SOA', ctx), SYNTH_DEV_DIR, 'integration-suite.local.tsv');
    const text = this.getOverlayFs().readManifest(manifestPath);
    const pins = new Map<string, string>();
    if (text !== null) {
      for (const row of parseOverlayTsv(text)) pins.set(row.repo, row.prs);
    }
    const result = await assessPosture({
      resolvePath: (name: string) => resolveOverlayRepo(name, ctx as ScriptContext).path,
      pins,
      git: this.getGitRunner(),
      gh: this.getGhRunner(),
      pathExists: this.getRepoDirCheck(),
    });
    return { overlayPresent: text !== null, result };
  }
}

/** Render one posture line with verify.sh's ✓/⚠/· glyphs. */
function renderPostureLine(l: PostureLine): string {
  if (l.level === 'ok') return `${green('✓')} ${dim(l.message)}`;
  if (l.level === 'warn') return `${yellow('⚠')} ${dim(l.message)}`;
  return dim(`· ${l.message}`);
}

/** A rendered verify row. */
interface VerifyRow {
  id: ServiceId;
  url: string;
  ok: boolean;
  status?: number;
  tolerated: boolean;
}

/** The subset of parsed verify flags the `--all-slots` path reads. */
interface AllSlotsFlags {
  full: boolean;
  'health-only': boolean;
  'output-json': boolean;
  porcelain: boolean;
  only?: string;
  with?: string[];
  dev: string;
  soa?: string;
  slot: number;
  set?: string;
}

/** One active slot's folded health (+ optional DATA) verdict. */
interface SlotReport {
  slot: number;
  project: string;
  rows: VerifyRow[];
  notCloned: ReturnType<typeof partitionByRepoPresence>['notCloned'];
  data?: DataAssessment;
  /** Count of health rows that answered up. */
  up: number;
  passed: boolean;
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
