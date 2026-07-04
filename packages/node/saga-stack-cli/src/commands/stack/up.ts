/**
 * `saga-stack stack up` — bring the synthetic dev stack up (NATIVE-BY-DEFAULT,
 * FLIP 1).
 *
 * THREE PATHS:
 *  - `--dry-run` (M0): resolve the dependency closure (`computeClosure`) and
 *    `emit()` it (services in launch order, databases, mesh, why each service is
 *    present). With `--only` it also prints the resolved native LAUNCH plan + the
 *    composed SEED plan. No docker / pnpm / health IO.
 *  - NATIVE (M4 partial-stack + FLIP 1 full-stack): the DEFAULT. `--only <svc,…>`
 *    boots that closure; a BARE `stack up` (no --only/--with) now EXPANDS to the
 *    full non-optional service set and boots it the SAME way. computeClosure →
 *    drive the in-process `StackApi.up(closure)` (native prep → native mesh +
 *    topo-wave service launch, NOT up.sh) → composeSeedPlan over the active closure
 *    → `StackApi.seed(plan)`. `--reset` is native (M8 R4); `--login` delegates to
 *    up.sh through the facade. M9: the native bare `up` now RUNS the ff-only auto-pull
 *    sibling sync (up.sh `pull_repos auto`; `--pull` = `all` mode, `--no-auto-pull` /
 *    `NO_AUTO_PULL` opt out) AND best-effort Connect AV (livekit :7880 + coturn, slot-0
 *    only, when connect is in the closure). Remaining gap: up.sh's branch-layout
 *    preflight (M12).
 *  - WRAPPED (the escape): `--legacy` forces the up.sh wrapper for the WHOLE
 *    bring-up. Additionally, a bare invocation carrying a flag the native path can't
 *    honour yet (sandbox/tunnel/workspace/record), or a
 *    SINGLE-service `--only` + such a flag, still falls back to the up.sh wrapper: a
 *    THIN WRAPPER mapping flags → `flagMap.up()` → the exact up.sh argv/env, shelled
 *    out with stdio inherited. A MULTI-service `--only` + such a flag is rejected
 *    (up.sh --only is single-service only). up.sh is hardcoded to slot 0, so at
 *    slot > 0 the bare set is always native and an unsupported flag hard-errors
 *    rather than clobbering slot 0.
 *
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run
 *   node bin/dev.js stack up --only scheduling-api,sessions-api          # native
 *   node bin/dev.js stack up                                             # native full stack
 *   node bin/dev.js stack up --legacy --seed roster --login             # wrapped (up.sh)
 *
 * Imports come straight from the specific core modules (not the `core/index`
 * barrel) so this command stays decoupled from the seed/flow sub-barrels.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import {
  BUNDLE_NAMES,
  combineRequested,
  effectiveWithPlayback,
  seedAddOnsFor,
} from '../../core/bundles.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance, slotExcludedServices } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import * as flagMap from '../../core/flag-map.js';
import type { RecordMode } from '../../core/flag-map.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { composeSeedPlan } from '../../core/seed/compose-seed-plan.js';
import type { SeedAddOn, SeedPlan, SeedProfile, SeedSelection } from '../../core/seed/types.js';
import { makeStackApi } from '../../stack-api.js';
import type { Runtime, StackApi } from '../../stack-api.js';

export default class StackUp extends BaseCommand {
  static description =
    'Bring the synthetic dev stack up. --only boots the dependency closure NATIVELY; full-stack wraps up.sh; --dry-run prints the planner.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api --dry-run',
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api',
    '<%= config.bin %> <%= command.id %> --seed roster --login',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'services to bring up. With --dry-run, a comma-list whose dependency closure is printed. On a real run (M4) a comma-list boots the closure NATIVELY (not via up.sh); combine with a flag the native path cannot honour yet (sandbox/tunnel/workspace/record/pull/prep) and a SINGLE service still falls back to up.sh.',
    }),
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) to include — sugar over --only (unions the bundle's services into the closure). Repeatable/composable: --with dash --with coach. `--with playback` includes the optional playback services (transcripts, insights, chat). Bundles: dash, connect, coach, playback.",
    }),
    'dry-run': Flags.boolean({
      description: 'plan only: print the resolved closure (+ launch/seed plan for --only) and exit without touching docker/pnpm',
      default: false,
    }),
    // ── up.sh trailing flags (wrapped path; some also drive the native path) ──
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
      description:
        'NATIVE (M9): run the ff-only sibling sync in `all` mode — every on-branch clean sibling, not just default-branch ones (up.sh --pull).',
      default: false,
    }),
    'no-auto-pull': Flags.boolean({
      description: 'NATIVE (M9): opt out of the ff-only auto-pull sync entirely (up.sh env NO_AUTO_PULL=1).',
      default: false,
    }),
    'skip-prep': Flags.boolean({
      description:
        'skip the R1 install+build prep pass. NATIVE (--only): skips R1 ONLY — R2 DB provision + R3 migrate still run (both idempotent). WRAPPED (full-stack): up.sh env SKIP_PREP=1 wraps the whole prep.',
      default: false,
    }),
    record: Flags.string({
      description:
        'record session traffic (up.sh --record <mode>). A value is required in the wrapper; up.sh\'s bare `--record` default is `crdt`, so pass `--record crdt` for that behavior.',
      options: ['crdt', 'av'],
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
    legacy: Flags.boolean({
      default: false,
      description:
        'force the bash `up.sh` wrapper for the WHOLE bring-up (the non-destructive escape) instead of the native path. Bare `stack up` is native-by-default; `--legacy` restores the old up.sh full-stack bring-up regardless of the other flags.',
    }),
  };

  /** M7 Phase 2: `stack up` brings up an isolated `soa-s<N>` stack at slot > 0. */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackUp);

    // requested = --only ids ∪ --with bundle ids (sugar over --only); `--with`
    // participates in the same closure resolution the native/dry-run paths use.
    let requested: ServiceId[] = combineRequested(flags.only, flags.with, (m) => this.error(m));
    let isOnly = requested.length > 0;
    const withPlayback = effectiveWithPlayback(flags.with);

    // ── --dry-run (M0/M4): planner only. ──
    if (flags['dry-run']) {
      this.runDryRun(flags, requested, isOnly, withPlayback);
      return;
    }

    // ── FLIP 1: `--legacy` is the non-destructive escape — force the up.sh wrapper
    // for the WHOLE bring-up regardless of the other flags. Reached before any native
    // routing so `ss stack up --legacy` reproduces the old bash full-stack up. ──
    if (flags.legacy) {
      // M7 BLOCKER-1: up.sh is hardcoded to slot 0 (project soa, base ports,
      // STATE=/tmp/sds-synthetic). At slot > 0 --legacy would shell out to up.sh and
      // CLOBBER the default slot-0 stack (silent data loss) — REFUSE rather than corrupt
      // it, mirroring the slot > 0 wrapper-fallback guard below.
      if (flags.slot > 0) {
        this.error(
          `slot ${flags.slot}: --legacy routes through the up.sh wrapper, which is hardcoded ` +
            'to slot 0 (project soa, base ports, STATE=/tmp/sds-synthetic) and would clobber it. ' +
            'Drop --legacy to bring the slot up natively.',
        );
      }
      await this.runWrapped(flags, requested);
      return;
    }

    // Flags the native path does NOT yet implement (sandbox/tunnel overlays, the
    // record bash prep) — a bring-up carrying one of these still routes through the
    // up.sh wrapper. `--skip-prep` is NOT here: it is NATIVE (M8). `--pull` /
    // `--no-auto-pull` are NOT here either: they are NATIVE (M9) — they select the
    // ff-only auto-pull mode (`all` / opt-out) the native `up` runs before the mesh/prep.
    const needsUpSh =
      flags.sandbox !== undefined ||
      flags.workspace !== undefined ||
      flags.tunnel ||
      flags.record !== undefined;

    // ── FLIP 1: a BARE full-stack `up` is NATIVE-BY-DEFAULT. Expand the bare request
    // to the FULL non-optional service set and route it through the native path
    // (native prep → launch → seed) — the SAME path `--only` uses. Two exceptions
    // both keep the up.sh wrapper for a bare invocation:
    //   • a native-unsupported flag is present at slot 0 (sandbox/tunnel/workspace/
    //     record) — those combos still need the bash prep, so the
    //     bare set is left empty and falls through to `runWrapped` below.
    //   • (there is no slot-0 wrapper exception beyond that — plain `ss stack up` now
    //     boots the full non-optional closure natively.)
    // M7 BLOCKER-1: at slot > 0 the bare request is ALWAYS expanded + native (up.sh is
    // hardcoded to slot 0 — project `soa`, base ports, STATE=/tmp/sds-synthetic — and
    // would clobber the default stack); a native-unsupported flag there hard-errors in
    // the `isOnly` block below rather than reaching `runWrapped`. The per-slot
    // exclusion filter in `runNative` drops the literal-port / un-slottable services,
    // so slot > 0 comes up as a BACKEND (+ saga-dash/coach) sub-stack.
    if (!isOnly && (flags.slot > 0 || !needsUpSh)) {
      requested = Object.values(manifest.services)
        .filter((s) => !s.optional)
        .map((s) => s.id);
      isOnly = true;
    }

    // ── NATIVE (M4 partial-stack / FLIP 1 full-stack): the requested set boots the
    // closure natively. Flags the native path can't honour yet force the up.sh
    // wrapper, which ONLY accepts a single service — so a multi-service set + such a
    // flag is rejected. ──
    if (isOnly) {
      if (!needsUpSh) {
        await this.runNative(flags, requested, withPlayback);
        return;
      }

      // M7 BLOCKER-1: the up.sh fallback below is hardcoded to slot 0 (project `soa`,
      // base ports, STATE=/tmp/sds-synthetic). At slot > 0 it would clobber slot 0,
      // so REFUSE rather than corrupt it — never fall through to `runWrapped`. (Native
      // overlays for --sandbox/--tunnel/… at slot > 0 are a documented fast-follow.)
      if (flags.slot > 0) {
        this.error(
          `slot ${flags.slot}: --sandbox/--tunnel/--workspace/--record ` +
            'route through the up.sh wrapper, which is hardcoded to slot 0 (project soa, base ports, ' +
            'STATE=/tmp/sds-synthetic) and would clobber it. Drop the flag to bring the slot up natively.',
        );
      }

      if (requested.length > 1) {
        this.error(
          'a multi-service --only/--with set boots the closure NATIVELY, but that path does not yet support --sandbox/--tunnel/--workspace/--record. Drop the unsupported flag (native), pass a single service (up.sh fallback), or use --dry-run to preview.',
        );
      }
      // Single service + an unsupported-native flag ⇒ fall through to the up.sh
      // wrapper below (preserves the M1 --sandbox/single-service behaviour). Only
      // reached at slot 0 (slot > 0 hard-errored just above).
    }

    // ── WRAPPED (the up.sh escape): thin wrapper over up.sh. Reached only at slot 0
    // and only for (a) a BARE invocation carrying a native-unsupported flag
    // (sandbox/tunnel/workspace/record → bare set left un-expanded
    // above), or (b) a SINGLE-service --only + such a flag. `--legacy` is handled
    // earlier (forces the wrapper unconditionally). slot > 0 can never reach here
    // (bare → native above; --only + unsupported flag → hard-error above). ──
    await this.runWrapped(flags, requested);
  }

  /** M0/M4 dry-run: print the closure (+ native launch/seed plan when --only/--with). */
  private runDryRun(
    flags: DryRunFlags,
    requested: ServiceId[],
    isOnly: boolean,
    withPlayback: boolean,
  ): void {
    const resolvedRequest: ServiceId[] = isOnly
      ? requested
      : Object.values(manifest.services)
          .filter((s) => !s.optional)
          .map((s) => s.id);

    const known = new Set(Object.keys(manifest.services));
    const unknown = resolvedRequest.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.error(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
    }

    const closure = computeClosure(manifest, resolvedRequest, { withPlayback });

    // M7: at slot > 0 the bring-up would EXCLUDE the literal-port services; surface
    // that in the preview so the dry-run matches what a real `--slot N` up launches.
    const slotExcluded = slotExcludedServices(flags.slot).filter((id) =>
      closure.services.includes(id),
    );

    const reasonsObj: Record<string, string[]> = {};
    for (const svc of closure.services) reasonsObj[svc] = closure.reasons.get(svc) ?? [];

    // For --only, also resolve the SEED plan over the active closure (the same
    // plan the native path would run) so the dry-run proves the full M4 picture.
    const seedPlan = isOnly
      ? composeSeedPlan(this.seedSelection(flags), new Set(closure.services), new Set<ServiceId>())
      : undefined;

    const json: Record<string, unknown> = {
      dryRun: true,
      requested: resolvedRequest,
      services: closure.services,
      databases: closure.databases,
      mesh: closure.mesh,
      reasons: reasonsObj,
      ...(slotExcluded.length > 0 ? { slot: flags.slot, slotExcluded } : {}),
      ...(seedPlan
        ? {
            native: true,
            seed: {
              offline: seedPlan.offline.map((s) => s.id),
              online: seedPlan.online.map((s) => s.id),
              skipped: seedPlan.skipped.map((s) => ({ id: s.id, reason: s.reason })),
            },
          }
        : {}),
    };

    const textLines: string[] = [
      `dry-run closure for: ${resolvedRequest.join(', ')}`,
      `services (launch order): ${closure.services.join(' -> ') || '(none)'}`,
      `databases: ${closure.databases.join(', ') || '(none)'}`,
      `mesh: ${closure.mesh.join(', ') || '(none)'}`,
      'reasons:',
      ...closure.services.map((svc) => `  ${svc}: ${(closure.reasons.get(svc) ?? []).join('; ')}`),
      ...(slotExcluded.length > 0
        ? [`slot ${flags.slot}: backend sub-stack — would EXCLUDE (literal-port + frontends, collide with slot 0): ${slotExcluded.join(', ')}`]
        : []),
    ];
    if (seedPlan) {
      textLines.push(
        `native partial-stack: would launch ${closure.services.length} service(s) and seed`,
        `  offline: ${seedPlan.offline.map((s) => s.id).join(', ') || '(none)'}`,
        `  online:  ${seedPlan.online.map((s) => s.id).join(', ') || '(none)'}`,
        `  skipped: ${seedPlan.skipped.map((s) => `${s.id} (${s.reason})`).join(', ') || '(none)'}`,
      );
    }

    this.emit(flags, json, textLines);
  }

  /** M4 native partial-stack: StackApi.up(closure) → composeSeedPlan → StackApi.seed(plan). */
  private async runNative(
    flags: NativeFlags,
    requested: ServiceId[],
    withPlayback: boolean,
  ): Promise<void> {
    const known = new Set(Object.keys(manifest.services));
    const unknown = requested.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.error(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
    }

    // M7: derive the slot profile once, up front — it drives the ports/project/
    // container-env threading (buildRuntime) AND the literal-port-service exclusion
    // below. At slot 0 the profile is the byte-identical no-offset default.
    const profile = deriveInstance({ slot: flags.slot });

    const fullClosure = computeClosure(manifest, requested, { withPlayback });

    // Exclude the literal-port backends (ads-adm-api/connect-api/playback trio) AND
    // the browser frontends (saga-dash/connect-web/coach-web — no listen-port seam)
    // from a slot > 0 bring-up: they'd collide with / split-brain onto slot 0 (see
    // SLOT_EXCLUDED_SERVICES). So slot > 0 is a BACKEND sub-stack. Empty at slot 0,
    // so slot 0 is unchanged.
    const excluded = new Set(profile.excludedServices);
    const services = fullClosure.services.filter((id) => !excluded.has(id));
    const droppedForSlot = fullClosure.services.filter((id) => excluded.has(id));
    if (droppedForSlot.length > 0) {
      this.log(
        `⚠ slot ${profile.slot}: backend sub-stack — excluding literal-port + frontend ` +
          `service(s) that would collide with slot 0: ${droppedForSlot.join(', ')}`,
      );
    }

    const api = makeStackApi(manifest, this.buildRuntime(flags, profile));

    // 1. native bring-up (mesh + topo-wave service launch + M9 auto-pull + AV).
    const up = await api.up(services);

    // M9 auto-pull: surface the ff-only sibling-sync outcome per repo (up.sh's
    // pull_repos ⚠/·/✓ lines). Printed first so a fast-forward / skip is visible even
    // on a later failure. Ran only when a git seam + a non-opt-out mode were wired.
    if (up.autoPull) {
      this.log(`sibling sync (ff-only — ${up.autoPull.mode}):`);
      for (const r of up.autoPull.repos) this.log(`  ${r.message}`);
    }

    // M9 Connect AV: best-effort livekit + coturn (slot-0 + connect-in-closure). up.sh's
    // connect_av_up ✓/⚠ — never a failure.
    if (up.av) this.log(up.av.message);

    // Surface any services skipped because their sibling repo isn't cloned (warn,
    // not fail) — e.g. a missing coach checkout. Printed before the failure/emit
    // so the warning is visible even on an unrelated launch failure.
    for (const s of up.skipped) this.log(`⚠ ${s.message}`);

    if (!up.ok) {
      this.logUpFailure(up);
      this.exit(1);
      return;
    }

    // 2. (optional) reset — NATIVE (M8 R4). Truncates the closure's DBs to an empty
    // baseline; the native seed below then applies the SELECTED profile/add-ons on top
    // (idempotent upserts). `withPlayback` MUST be threaded so `--with playback --reset`
    // also truncates the playback trio (transcripts/insights/chat) — matching both
    // `up.sh --reset --with-playback` and the dedicated `stack reset --with playback`.
    if (flags.reset) {
      const reset = await api.reset(services, { withPlayback });
      if (reset.code !== 0) this.exit(reset.code);
    }

    // 3. seed: compose over the ACTIVE set — the closure MINUS any service skipped
    // because its repo isn't cloned. Composing over the full closure would still
    // plan a skipped service's steps (e.g. coach-pg) and then spawn-crash on the
    // missing coach-db dir, defeating the skip guard; gate-1 drops them here as
    // service-inactive instead. (restored = empty for M4 — snapshot integration can
    // pass a fully-restored set later.)
    const skippedIds = new Set(up.skipped.map((s) => s.id));
    const active = new Set(services.filter((id) => !skippedIds.has(id)));
    const plan: SeedPlan = composeSeedPlan(
      this.seedSelection(flags),
      active,
      new Set<ServiceId>(),
    );
    const seeded = await api.seed(plan);

    // 4. (optional) login — DELEGATED to up.sh for M4.
    if (flags.login) await api.login();

    // MAJOR-C: R1 records non-fatal build/db:generate failures as warnings (up.sh
    // warn+continue) rather than aborting — surface them so they're visible.
    for (const w of up.prep?.warnings ?? []) {
      this.log(`⚠ prep: ${w.repo} ${w.kind} failed (non-fatal, continued)`);
    }

    // Report.
    const launchedIds = up.launched.map((r) => `${r.id}${r.alreadyUp ? ' (already up)' : ''}`);
    this.emit(
      flags,
      {
        native: true,
        services,
        ...(up.autoPull
          ? {
              autoPull: {
                mode: up.autoPull.mode,
                repos: up.autoPull.repos.map((r) => ({ name: r.name, action: r.action, ...(r.reason ? { reason: r.reason } : {}), ...(r.behind !== undefined ? { behind: r.behind } : {}) })),
              },
            }
          : {}),
        ...(up.av ? { av: { attempted: up.av.attempted, ok: up.av.ok } } : {}),
        launched: up.launched.map((r) => ({ id: r.id, ok: r.ok, alreadyUp: r.alreadyUp ?? false, pid: r.pid ?? null })),
        skipped: up.skipped.map((s) => ({ id: s.id, repo: s.repo, repoDir: s.repoDir })),
        mesh: { ok: up.mesh.ok, units: up.mesh.units.map((u) => ({ id: u.id, ok: u.ok })) },
        dash: up.dash?.action ?? null,
        seed: {
          ok: seeded.ok,
          offline: seeded.ran.offline,
          online: seeded.ran.online,
          skipped: seeded.skipped.map((s) => ({ id: s.id, reason: s.reason })),
          ...(seeded.failed ? { failed: seeded.failed } : {}),
        },
      },
      [
        `native partial-stack up: ${up.launched.length} service(s) launched${up.skipped.length ? `, ${up.skipped.length} skipped` : ''}`,
        `launched: ${launchedIds.join(', ')}`,
        ...(up.skipped.length ? [`skipped (repo not cloned): ${up.skipped.map((s) => s.id).join(', ')}`] : []),
        `mesh: ${up.mesh.units.map((u) => `${u.id}=${u.ok ? 'ready' : 'DOWN'}`).join(', ') || '(none)'}`,
        ...(up.dash ? [`dash defaults: ${up.dash.action}`] : []),
        `seed offline: ${seeded.ran.offline.join(', ') || '(none)'}`,
        `seed online:  ${seeded.ran.online.join(', ') || '(none)'}`,
        seeded.ok ? 'seed: OK' : `seed: FAILED at ${seeded.failed}`,
      ],
    );

    if (!seeded.ok) this.exit(1);
  }

  /**
   * M1 wrapped path: map flags → up.sh argv/env and shell out. `--with` bundles
   * resolve to up.sh's `--only` (the combined `requested` set — a single service
   * on the wrapped fallback, or empty for the full stack) and drive `withPlayback`.
   */
  private async runWrapped(flags: WrappedFlags, requested: ServiceId[]): Promise<void> {
    const plan = flagMap.up({
      reset: flags.reset,
      seed: flags.seed as SeedProfile | undefined,
      pull: flags.pull,
      noAutoPull: flags['no-auto-pull'],
      skipPrep: flags['skip-prep'],
      record: flags.record as RecordMode | undefined,
      withPlayback: effectiveWithPlayback(flags.with),
      withQtfDemo: (flags.with ?? []).includes('qtf'),
      tunnel: flags.tunnel,
      login: flags.login,
      only: requested.length > 0 ? requested.join(',') : flags.only,
      sandbox: flags.sandbox,
      workspace: flags.workspace,
    });
    await this.runScript(plan, flags);
  }

  /**
   * Build the seed selection from the up flags: the profile plus the seed add-ons
   * the `--with` features contribute (`--with playback` ⇒ playback, `--with qtf`
   * ⇒ qtf) — derived from the bundle registry so it cannot drift from `--with`.
   */
  private seedSelection(flags: { seed?: string; with?: string[] }): SeedSelection {
    const addOns: SeedAddOn[] = seedAddOnsFor(flags.with);
    // up.sh's bare `--seed` defaults to `roster`; an absent --seed on a native
    // bring-up still seeds the roster baseline (matching the daily-driver default).
    return { profile: (flags.seed as SeedProfile | undefined) ?? 'roster', addOns };
  }

  /**
   * Assemble the in-process `Runtime` — delegates to the shared
   * `BaseCommand.buildNativeRuntime` (which wires the slot threading, repo-root
   * resolution, and the M8 prep seams in one place, shared with `stack reset`).
   */
  private buildRuntime(flags: NativeFlags, profile: InstanceProfile): Runtime {
    return this.buildNativeRuntime(flags, profile);
  }

  /** Print a structured failure when the native bring-up did not reach all-healthy. */
  private logUpFailure(up: Awaited<ReturnType<StackApi['up']>>): void {
    if (up.mesh.conflicts.length > 0) {
      this.log('mesh preflight FAILED — host port conflicts:');
      for (const c of up.mesh.conflicts) this.log(`  ✗ ${c.message}`);
      return;
    }
    if (!up.mesh.makeOk) {
      this.log('mesh bring-up FAILED (`make up` exited non-zero)');
      return;
    }
    const downUnits = up.mesh.units.filter((u) => !u.ok).map((u) => u.id);
    if (downUnits.length > 0) {
      this.log(`mesh units never became ready: ${downUnits.join(', ')}`);
      return;
    }
    this.log(`service launch FAILED at ${up.failedAt ?? '(unknown)'} — it never became healthy`);
  }
}

// Local flag shapes (subset of the parsed StackUp flags each path reads).
type DryRunFlags = WorkspaceFlags & {
  porcelain: boolean;
  'output-json': boolean;
  slot: number;
  with?: string[];
  seed?: string;
};
type NativeFlags = DryRunFlags & {
  'state-dir'?: string;
  slot: number;
  reset: boolean;
  login: boolean;
  'skip-prep': boolean;
  pull: boolean;
  'no-auto-pull': boolean;
};
type WrappedFlags = WorkspaceFlags & {
  reset: boolean;
  seed?: string;
  pull: boolean;
  'no-auto-pull': boolean;
  'skip-prep': boolean;
  record?: string;
  with?: string[];
  tunnel: boolean;
  login: boolean;
  only?: string;
  sandbox?: string;
  workspace?: string;
};
