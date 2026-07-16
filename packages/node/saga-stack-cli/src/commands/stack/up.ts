/**
 * `saga-stack stack up` — bring the synthetic dev stack up (NATIVE-BY-DEFAULT,
 * FLIP 1).
 *
 * FULLY NATIVE (Phase 2, saga-ed/soa#214): `up` NEVER shells out to up.sh. TWO PATHS:
 *  - `--dry-run` (M0): resolve the dependency closure (`computeClosure`) and
 *    `emit()` it (services in launch order, databases, mesh, why each service is
 *    present). With `--only` it also prints the resolved native LAUNCH plan + the
 *    composed SEED plan. No docker / pnpm / health IO.
 *  - NATIVE (the DEFAULT, and now the ONLY bring-up path). `--only <svc,…>` boots
 *    that closure; a BARE `stack up` (no --only/--with/--workspace) EXPANDS to the
 *    full non-optional service set and boots it the SAME way. computeClosure →
 *    drive the in-process `StackApi.up(closure)` (native prep → native mesh +
 *    topo-wave service launch) → composeSeedPlan → `StackApi.seed(plan)`.
 *    Phase-2 flags are all NATIVE overlays on this ONE path:
 *      • `--sandbox <name>` / `--workspace <f>.json`  → the `sandbox_env` dep-repoint
 *        overlay (iam URL flip + PREVIEW_ORIGINATE_MAP), resolved in `resolveLaunchEnv`.
 *      • `--tunnel`  → resolve the moniker from the VENDORED `tunnel.sh`, build the
 *        launch env with the `tunnel_env` browser-plane overlay, then run vendored
 *        `tunnel.sh up` after a healthy launch. slot-0 only (fixed browser ports).
 *      • `--record [crdt|av]`  → start the fleek recording sidecars after launch
 *        (fleek-gated: a missing checkout is a warning skip, never a failure).
 *    `--reset` is native (M8 R4); the ff-only auto-pull + best-effort Connect AV run
 *    on the bare native `up` (M9). `--login` is NATIVE too (Phase-2 FINISH): it mints the
 *    headless cookie jar + best-effort-opens the vendored browser-login.mjs — NO up.sh.
 *
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run
 *   node bin/dev.js stack up --only scheduling-api,sessions-api          # native
 *   node bin/dev.js stack up                                             # native full stack
 *   node bin/dev.js stack up --only sis-api --sandbox dev                # native (sandbox_env)
 *   node bin/dev.js stack up --tunnel                                    # native + vendored tunnel.sh
 *
 * Imports come straight from the specific core modules (not the `core/index`
 * barrel) so this command stays decoupled from the seed/flow sub-barrels.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { NativeOverlays, WorkspaceFlags } from '../../base-command.js';
import {
  BUNDLE_NAMES,
  combineRequested,
  effectiveWithAuthz,
  effectiveWithPlayback,
  seedAddOnsFor,
} from '../../core/bundles.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance, slotExcludedServices } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import * as flagMap from '../../core/flag-map.js';
import type { RecordMode } from '../../core/flag-map.js';
import { DEFAULT_LOGIN_USER } from '../../core/login.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { composeSeedPlan } from '../../core/seed/compose-seed-plan.js';
import type { SeedAddOn, SeedPlan, SeedProfile, SeedSelection } from '../../core/seed/types.js';
import { parseWorkspace } from '../../core/workspace.js';
import type { WorkspaceSelection } from '../../core/workspace.js';
import { resolveVendorScript } from '../../runtime/index.js';
import { makeStackApi } from '../../stack-api.js';
import type { Runtime, StackApi } from '../../stack-api.js';

/** `--sandbox <name>` shape gate (up.sh ~2154; the composition API's IDENTIFIER shape). */
const SANDBOX_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$/;

export default class StackUp extends BaseCommand {
  static description =
    'Bring the synthetic dev stack up NATIVELY (--only boots the dependency closure; a bare up boots the full stack). --sandbox/--workspace/--record/--tunnel are native overlays (NO up.sh); --dry-run prints the planner.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api --dry-run',
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api',
    '<%= config.bin %> <%= command.id %> --seed roster --login',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'services to bring up. With --dry-run, a comma-list whose dependency closure is printed. On a real run a comma-list boots the closure NATIVELY (never up.sh); combine freely with --sandbox/--tunnel/--record (all native Phase-2 overlays).',
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
    // ── daily-driver flags — all NATIVE (no up.sh wrapper remains). ──
    reset: Flags.boolean({
      description: 'truncate + re-seed the data DBs before bringing services up (native — up.sh --reset parity)',
      default: false,
    }),
    seed: Flags.string({
      description:
        'seed the named profile after launch (native). An absent --seed still seeds the `roster` baseline (the up.sh bare-default).',
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
        'skip the R1 install+build prep pass (NATIVE); R2 DB provision + R3 migrate still run (both idempotent).',
      default: false,
    }),
    yes: Flags.boolean({
      char: 'y',
      description:
        'non-interactive: if a prep lock is held by a STOPPED/abandoned holder (e.g. a suspended `ss stack up`), kill it and reclaim the lock without prompting (CI / agents).',
      default: false,
    }),
    'allow-primary': Flags.boolean({
      description:
        "M13-B escape hatch: let a --set entry point a BUILDABLE repo at the primary $DEV checkout (prep will build your live working copy — tenet 4 says use a clean worktree; the preflight normally refuses).",
      default: false,
    }),
    record: Flags.string({
      description:
        'NATIVE (Phase 2): after launch, start the fleek recording stack (recorder :7890 + recordings-api :8444 + MinIO; `av` adds the LiveKit egress). Fleek-gated: skipped with a warning if the fleek repo is not cloned.',
      options: ['crdt', 'av'],
    }),
    tunnel: Flags.boolean({
      description:
        'NATIVE (Phase 2): launch with the tunnel_env browser-plane overlay (moniker from the vendored tunnel.sh) then run vendored tunnel.sh up. Slot-0 only (fixed browser ports).',
      default: false,
    }),
    login: Flags.boolean({
      description:
        'log in the default persona (dev@saga.org) after launch (NATIVE — mints the headless cookie jar + best-effort opens the vendored browser-login.mjs, no up.sh); use `stack login <email>` to override.',
      default: false,
    }),
    sandbox: Flags.string({
      description:
        'NATIVE (Phase 2): point a local service set at a cloud sandbox — the sandbox_env dep-repoint overlay (iam URL flip + preview-routing header). Accompanies --only/--with.',
    }),
    workspace: Flags.string({
      description:
        'NATIVE (Phase 2): a switchboard workspace.json selecting per-service run mode (local-source/sandbox) — the general case of --only/--sandbox.',
    }),
  };

  /** M7 Phase 2: `stack up` brings up an isolated `soa-s<N>` stack at slot > 0. */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `stack up --set <name>` runs the set's repos on its slot. */
  protected setAware(): boolean {
    return true;
  }

  /** Slot claims: `up` DRIVES the slot's stack — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackUp);

    // ── --workspace (Phase 2): a switchboard manifest is the GENERAL case of
    // --only/--sandbox — parse it (pure) into the run-set + iam-sandbox + playback,
    // rejecting the combos up.sh rejects. Its run-set becomes `requested`. ──
    const ws = this.resolveWorkspace(flags);

    // requested = workspace run-set, else --only ids ∪ --with bundle ids (sugar over
    // --only); `--with` participates in the same closure resolution.
    let requested: ServiceId[] = ws
      ? ws.runSet
      : combineRequested(flags.only, flags.with, (m) => this.error(m));
    let isOnly = requested.length > 0 || ws !== undefined;
    const withPlayback = ws ? ws.playback : effectiveWithPlayback(flags.with);
    // Workspace files carry no authz axis (mirrors playback's `ws.playback`, but
    // `--with authz` is a `--only`/`--with` concept only, not modeled in workspace JSON).
    const withAuthz = ws ? false : effectiveWithAuthz(flags.with);

    // ── --dry-run (M0/M4): planner only. Compute the SAME sandbox/workspace prune the
    // launch path applies (BLOCKER-1) so the dry-run reflects what actually launches. ──
    if (flags['dry-run']) {
      this.runDryRun(flags, requested, isOnly, withPlayback, withAuthz, {
        sandboxHybrid: flags.sandbox !== undefined,
        sandboxServices: ws ? new Set(ws.sandboxServices) : undefined,
        sandboxName: ws?.iamSandbox ?? flags.sandbox,
      });
      return;
    }

    // ── Phase 2 flag guards (all four flags are now NATIVE — no up.sh wrapper). ──
    //  - `--sandbox <name>` accompanies a service set (up.sh: --sandbox requires --only)
    //    and must match the composition-API IDENTIFIER shape.
    //  - `--tunnel` fronts the FIXED slot-0 browser ports (dash :8900 / connect :6210 /
    //    iam :3010) via the vms rendezvous box, so it is slot-0-only (hard-error at slot > 0,
    //    mirroring up.sh's hardcoded-slot-0 tunnel).
    const sandboxName = ws?.iamSandbox ?? flags.sandbox;
    if (flags.sandbox !== undefined) {
      if (!isOnly) {
        this.error('--sandbox <name> requires --only/--with (point a LOCAL service set at the sandbox; the rest are the sandbox)');
      }
      if (!SANDBOX_NAME_RE.test(flags.sandbox)) {
        this.error(`--sandbox: '${flags.sandbox}' must match [a-zA-Z0-9][a-zA-Z0-9-]{0,39}`);
      }
    }
    if (flags.tunnel && flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: --tunnel fronts the FIXED slot-0 browser ports (dash :8900 / connect :6210 / iam :3010) ` +
          'via the vms rendezvous box, so it cannot run against a peer slot. Bring the slot up without --tunnel.',
      );
    }

    // ── FLIP 1: a BARE full-stack `up` (no --only/--with/--workspace) is NATIVE — expand
    // to the FULL non-optional service set and route it through the native path (native
    // prep → launch → seed), the SAME path `--only` uses. There is NO up.sh wrapper left:
    // --sandbox/--tunnel/--record are all NATIVE now (Phase 2, saga-ed/soa#214). ──
    if (!isOnly) {
      requested = Object.values(manifest.services)
        .filter((s) => !s.optional)
        .map((s) => s.id);
      isOnly = true;
    }

    // ── NATIVE: the requested set boots the closure natively, carrying the resolved
    // sandbox/tunnel/record overlays. No path shells out to up.sh. ──
    //
    // BLOCKER-1 (Phase 2): the sandboxed deps live in the CLOUD, so they must NOT be
    // launched locally even though the closure pulls them in — parity with up.sh's
    // `want_service` (launch only the run-set; mode:sandbox services live in the cloud).
    //  - `--sandbox <name>` accompanies `--only`: launch the run-set ALONE (subtract the
    //    deps the closure pulled in — iam-api et al. live at the cloud sandbox).
    //  - `--workspace`: subtract EVERY mode:sandbox service id (`ws.sandboxServices`).
    const overlays = await this.resolveOverlays(flags, sandboxName, withAuthz);
    await this.runNative(flags, requested, withPlayback, withAuthz, overlays, {
      sandboxHybrid: flags.sandbox !== undefined,
      sandboxServices: ws ? new Set(ws.sandboxServices) : undefined,
      sandboxName,
    });
  }

  /**
   * Parse `--workspace <file.json>` (pure `parseWorkspace`) into the native launch
   * selection, enforcing up.sh's mutual-exclusion with --only/--with/--sandbox and
   * surfacing the parser's non-fatal warnings. Returns `undefined` when --workspace
   * is absent.
   */
  private resolveWorkspace(flags: WorkspaceParseFlags): WorkspaceSelection | undefined {
    if (flags.workspace === undefined) return undefined;
    if (flags.only !== undefined || flags.with !== undefined || flags.sandbox !== undefined) {
      this.error('--workspace cannot be combined with --only/--with/--sandbox (it is the general case of both)');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(flags.workspace, 'utf8'));
    } catch (e) {
      this.error(`--workspace: cannot read/parse '${flags.workspace}': ${(e as Error).message}`);
    }
    let selection: WorkspaceSelection;
    try {
      selection = parseWorkspace(raw as Parameters<typeof parseWorkspace>[0]);
    } catch (e) {
      this.error((e as Error).message);
    }
    for (const w of selection.warnings) this.log(`⚠ ${w}`);
    return selection;
  }

  /**
   * Resolve the Phase-2 native overlays from the flags: the `sandbox_env` input
   * (`--sandbox`/workspace iam-sandbox), the `tunnel_env` input (resolving the moniker
   * via the VENDORED tunnel.sh BEFORE the launch env is built so the URLs are correct),
   * and the `--record` seam. IO (moniker resolution) happens here, behind the
   * `getTunnelMoniker` seam so unit tests inject a fixed moniker.
   */
  private async resolveOverlays(
    flags: OverlayFlags,
    sandboxName?: string,
    withAuthz?: boolean,
  ): Promise<NativeOverlays> {
    const overlays: NativeOverlays = {};

    // `--with authz`: hand the flag down as data (the store-id FILE READ itself
    // stays in base-command.ts's buildNativeRuntime, the ONE place repoRoots is
    // resolved — see readOpenfgaStoreId). Absent ⇒ base env only (opt-in).
    if (withAuthz) {
      overlays.authz = { withAuthz: true };
    }

    if (sandboxName !== undefined) {
      // up.sh SANDBOX_BASE default (dev fleet); env-overridable like up.sh.
      overlays.sandbox = { name: sandboxName, base: process.env.SANDBOX_BASE };
    }

    if (flags.tunnel) {
      // Resolve the moniker from the VENDORED tunnel.sh (up.sh `$(tunnel.sh moniker)`)
      // BEFORE building the launch env — tunnel_env needs <moniker>.<VMS_BASE>.
      const vmsBase = process.env.VMS_BASE ?? 'vms.wootdev.com';
      const moniker = await this.getTunnelMoniker()(resolveVendorScript('tunnel.sh'));
      const domain = `${moniker}.${vmsBase}`;
      overlays.tunnel = { domain };

      // BLOCKER-2 (Phase 2): GENERATE `<stateDir>/rtsm-fleet-tunnel.json` (node endpoint
      // swapped to `rtsm.<domain>`) and point `overlays.tunnel.rtsmFleetPath` at it, so
      // `tunnelOverlay(rtsm-api)` flips FLEET_CONFIG_PATH off the localhost:6110 local
      // fleet and a remote browser's CRDT discovery resolves a reachable node (up.sh
      // ~2170-2188). Base-command forwards `tunnel.rtsmFleetPath` → TUNNEL_RTSM_FLEET_PATH.
      // Best-effort: a null (unreadable base file) leaves rtsm-api on its local fleet.
      // --tunnel is slot-0-only (guarded upstream), so this is the slot-0 STATE dir
      // unless the user pinned `--state-dir`.
      const stateDir = flags['state-dir'] ?? deriveInstance({ slot: flags.slot }).stateDir;
      const rtsmFleetPath = this.getTunnelFleetGen()({
        // Generate the tunnel fleet from the CLI's VENDORED base (Phase-2 DECOUPLING) —
        // NOT a soa checkout's `tools/synthetic-dev/rtsm-fleet-local.json`.
        localFleetPath: resolveVendorScript('rtsm-fleet-local.json'),
        outPath: `${stateDir}/rtsm-fleet-tunnel.json`,
        tunnelDomain: domain,
      });
      if (rtsmFleetPath) overlays.tunnel.rtsmFleetPath = rtsmFleetPath;

      // Real-cluster A/V (up.sh's best-effort Secrets Manager fetch, up.sh:2346-2351):
      // fetch the fleek LiveKit key/secret so connect-api signs tokens the fleek dev
      // cluster ACCEPTS. Absent (no dev creds / secret) ⇒ connect-api keeps the local
      // dev key, the cluster rejects the tokens, and only A/V fails — CRDT/chat and the
      // rest of tunnel mode work. Behind a seam so unit tests inject fixed creds.
      const lk = this.getFleekCreds()(resolveVendorScript('tunnel.sh'));
      if (lk) {
        overlays.tunnel.lkKey = lk.key;
        overlays.tunnel.lkSecret = lk.secret;
        this.log('tunnel A/V: fleek dev-cluster LiveKit creds resolved (real camera/mic).');
      } else {
        this.warn(
          'tunnel A/V: could not fetch qboard/fleek/livekit-creds — real A/V will fail ' +
            '(connect-api signs LiveKit tokens with the dev key, which the fleek cluster ' +
            'rejects). CRDT/chat still work. `aws sso login` to the dev account + re-up for cluster A/V.',
        );
      }
    }

    if (flags.record !== undefined) {
      overlays.record = flags.record as RecordMode;
      overlays.recordUp = this.getRecordUp();
    }

    return overlays;
  }

  /** M0/M4 dry-run: print the closure (+ native launch/seed plan when --only/--with). */
  private runDryRun(
    flags: DryRunFlags,
    requested: ServiceId[],
    isOnly: boolean,
    withPlayback: boolean,
    withAuthz: boolean,
    prune: LaunchPrune = {},
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

    const closure = computeClosure(manifest, resolvedRequest, { withPlayback, withAuthz });

    // M7: at slot > 0 the bring-up would EXCLUDE the literal-port services; surface
    // that in the preview so the dry-run matches what a real `--slot N` up launches.
    const slotExcluded = slotExcludedServices(flags.slot).filter((id) =>
      closure.services.includes(id),
    );

    // BLOCKER-1 (Phase 2): compute the SAME sandbox/workspace prune `runNative` applies —
    // the sandbox-hosted deps live in the CLOUD and are NOT launched locally. Surface the
    // resulting LAUNCH SET (+ which deps are hosted) so the dry-run reflects reality.
    const slotExcludedSet = new Set<ServiceId>(slotExcluded);
    const sandboxDrop = sandboxDropSet(prune, requested, closure.services);
    const sandboxHosted = closure.services.filter((id) => sandboxDrop.has(id) && !slotExcludedSet.has(id));
    const launchSet = closure.services.filter((id) => !slotExcludedSet.has(id) && !sandboxDrop.has(id));

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
      ...(sandboxHosted.length > 0
        ? { launchSet, sandboxHosted, ...(prune.sandboxName ? { sandbox: prune.sandboxName } : {}) }
        : {}),
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
      ...(sandboxHosted.length > 0
        ? [
            `launch set (sandbox/workspace prune): ${launchSet.join(', ') || '(none)'} ` +
              `(${sandboxHosted.join(', ')} hosted${prune.sandboxName ? ` at sandbox '${prune.sandboxName}'` : ''}, not launched locally)`,
          ]
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
    withAuthz: boolean,
    overlays: NativeOverlays = {},
    prune: LaunchPrune = {},
  ): Promise<void> {
    const known = new Set(Object.keys(manifest.services));
    const unknown = requested.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.error(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
    }

    // M13-B: the implicit set preflight (no-op without --set) — hard-error on
    // missing/non-checkout paths, buildable-at-primary (unless --allow-primary),
    // and cross-set build collisions BEFORE any stack mutation.
    await this.runSetPreflight(flags);

    // M7: derive the slot profile once, up front — it drives the ports/project/
    // container-env threading (buildRuntime) AND the literal-port-service exclusion
    // below. At slot 0 the profile is the byte-identical no-offset default.
    const profile = deriveInstance({ slot: flags.slot });

    // NB: the per-slot rtsm fleet (soa#271 — so a slot's Connect browser CRDT reaches
    // THIS slot's rtsm, not slot 0's) is generated in `buildRuntime`, the seam BOTH
    // `stack up` and `e2e run` share; it need not be repeated here.

    const fullClosure = computeClosure(manifest, requested, { withPlayback, withAuthz });

    // Exclude the still-un-slottable services from a slot > 0 bring-up: only the
    // literal-port playback trio (transcripts/insights/chat) carries literal cross-slot
    // ports that would collide with slot 0 (see SLOT_EXCLUDED_SERVICES). connect-api,
    // connect-web and the saga-dash/coach frontends are all slottable now (soa#271 /
    // the M13 listen-port seam; connect-web shares the one slot-0 livekit + dials its
    // own slot's rtsm via the per-slot fleet above). Empty at slot 0, so slot 0 is unchanged.
    const excluded = new Set(profile.excludedServices);

    // BLOCKER-1 (Phase 2): the sandbox-hosted deps live in the CLOUD — subtract them
    // from the LOCAL launch set (parity with up.sh's `want_service`, which launches
    // only the run-set; a mode:sandbox dep pulled into the closure never boots locally).
    // The launched services' own mesh/DBs still come up (neededMesh/neededDbs run over
    // this pruned set); the excluded deps' don't. Plain `--only` closure is UNTOUCHED.
    const sandboxDrop = sandboxDropSet(prune, requested, fullClosure.services);

    const services = fullClosure.services.filter((id) => !excluded.has(id) && !sandboxDrop.has(id));
    const droppedForSlot = fullClosure.services.filter((id) => excluded.has(id));
    if (droppedForSlot.length > 0) {
      this.log(
        `⚠ slot ${profile.slot}: backend sub-stack — excluding literal-port ` +
          `service(s) that would collide with slot 0: ${droppedForSlot.join(', ')}`,
      );
    }
    const droppedForSandbox = fullClosure.services.filter((id) => sandboxDrop.has(id) && !excluded.has(id));
    if (droppedForSandbox.length > 0) {
      this.log(
        '⚠ sandbox/workspace: launching the local run-set only — the sandbox-hosted ' +
          `dep(s) live in the cloud, not launched locally: ${droppedForSandbox.join(', ')}`,
      );
    }

    const api = makeStackApi(manifest, this.buildRuntime(flags, profile, overlays));

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
    // (idempotent upserts). `withPlayback`/`withAuthz` MUST be threaded so
    // `--with playback --reset` / `--with authz --reset` also truncate their opt-in
    // DBs (playback trio / openfga+authz_sync_local) — matching both
    // `up.sh --reset --with-playback` and the dedicated `stack reset --with playback`.
    if (flags.reset) {
      const reset = await api.reset(services, { withPlayback, withAuthz });
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

    // Phase 2 --tunnel: after a successful native (tunnel-aware) launch, start the
    // reverse tunnels via the VENDORED tunnel.sh (up.sh drives the frpc tunnels the
    // same way). stdio-inherited so the frpc progress owns the TTY. Ordered BEFORE
    // login (up.sh: tunnel.sh up → login_user) so a `--tunnel --login` mints against
    // the PUBLIC iam host the tunnels now expose; a bare `--tunnel` just runs it a
    // step earlier. `loginTunnelDomain` (set only when the tunnels actually came up)
    // is what routes the login below at the tunnel hosts.
    const loginTunnelDomain = overlays.tunnel && seeded.ok ? overlays.tunnel.domain : undefined;
    if (overlays.tunnel && seeded.ok) {
      const script = resolveVendorScript('tunnel.sh');
      const plan = flagMap.tunnel('up');
      await this.runVendor({ cwd: dirname(script), command: script, args: plan.args, env: plan.env }, flags);
      this.log(`tunnel mode: browser plane at https://<svc>.${overlays.tunnel.domain}`);
    }

    // 4. (optional) login — NATIVE (Phase-2 FINISH, saga-ed/soa#214). No up.sh: mint the
    // headless cookie jar (default persona dev@saga.org, slot-aware) via the SHARED
    // BaseCommand helper, then best-effort open the vendored browser-login.mjs — exactly
    // what up.sh's `--login` did (jar + best-effort headful browser). BEST-EFFORT: a
    // devLogin miss (login-before-seed) or a browser failure (no DISPLAY/playwright) is a
    // warning only — it must NOT redden an otherwise-healthy stack, so it never exits `up`.
    // Under --tunnel, route login through the PUBLIC tunnel hosts (iam.<domain> /
    // dash.<domain>) so the minted cookie is scoped for the tunnel (iam sets
    // AUTH_SESSIONCOOKIEDOMAIN=.<domain>, which a localhost mint would mis-scope); else
    // slot-offset localhost.
    if (flags.login) {
      const loginStateDir = flags['state-dir'] ?? profile.stateDir;
      const res = await this.mintNativeLoginJar({
        email: DEFAULT_LOGIN_USER,
        slot: flags.slot,
        stateDir: loginStateDir,
        loginIamUrl: loginTunnelDomain ? `https://iam.${loginTunnelDomain}` : undefined,
      });
      if (res.ok) {
        this.log(`✓ login: session minted — cookie jar → ${res.jarPath} (cookies: ${res.captured.join(', ') || '(none)'})`);
        // Best-effort headful Chromium — up.sh --login opens it too. browser-login.mjs
        // targets the FIXED slot-0 dash, so only attempt it at slot 0 (a slot > 0 up
        // still gets its native jar; the browser step is simply skipped).
        if (flags.slot === 0) {
          await this.openVendoredBrowser(flags, {
            email: DEFAULT_LOGIN_USER,
            iamUrl: res.iamUrl,
            stateDir: loginStateDir,
            dashUrl: loginTunnelDomain ? `https://dash.${loginTunnelDomain}` : undefined,
          });
        }
      } else {
        this.log(
          `⚠ login: devLogin failed (HTTP ${res.status}) for ${DEFAULT_LOGIN_USER} — the rostered ` +
            'admin only exists after a roster seed. Seed first, then `stack login`. (Stack is up; login is best-effort.)',
        );
      }
    }

    // Phase 2 --record: surface the fleek recording-stack bring-up (✓ up / ⚠ skipped
    // fleek-absent / ⚠ failed). Never fatal — a record hiccup can't redden an
    // otherwise-healthy stack (like the AV bring-up).
    if (up.record) this.log(up.record.message);

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
        dashConfigEnv: up.dashConfigEnv ?? null,
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
        // soa#328: the per-instance dash routing env (same JSON as the file write).
        ...(up.dashConfigEnv
          ? [`dash config env: DASH_CONFIG_LOCAL_JSON injected (${up.dashConfigEnv.mode}, slot ${up.dashConfigEnv.slot})`]
          : []),
        `seed offline: ${seeded.ran.offline.join(', ') || '(none)'}`,
        `seed online:  ${seeded.ran.online.join(', ') || '(none)'}`,
        seeded.ok ? 'seed: OK' : `seed: FAILED at ${seeded.failed}`,
      ],
    );

    if (!seeded.ok) this.exit(1);
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
  private buildRuntime(
    flags: NativeFlags,
    profile: InstanceProfile,
    overlays: NativeOverlays,
  ): Runtime {
    return this.buildNativeRuntime(flags, profile, overlays);
  }

  /** Print a structured failure when the native bring-up did not reach all-healthy. */
  private logUpFailure(up: Awaited<ReturnType<StackApi['up']>>): void {
    for (const line of describeUpFailure(up)) this.log(line);
  }
}

/**
 * Structural subset of the up-result that {@link describeUpFailure} reads — the full
 * `Awaited<ReturnType<StackApi['up']>>` is assignable to it (literal ids widen to string).
 */
export interface UpFailureView {
  mesh: {
    conflicts: readonly { readonly message: string }[];
    makeOk: boolean;
    units: readonly { readonly id: string; readonly ok: boolean }[];
  };
  prep?: { ok: boolean; failed?: { repo: string; kind: string; argv: readonly string[]; detail?: string } };
  provision?: { ok: boolean; failed?: string };
  migrate?: { ok: boolean; failed?: string };
  failedAt?: string;
  failedReason?: string;
}

/**
 * Map a failed bring-up to the human failure lines. Pure (no IO) so the branch logic is
 * unit-testable. The order mirrors `StackApi.up()`'s phases: mesh → native prep pass
 * (R1 build/install → R2 provision → R3 migrate) → launch waves. The prep/provision/migrate
 * phases return `ok:false` with NO `failedAt`, so before this fix any failure there fell
 * through to the launch line and misreported as `service launch FAILED at (unknown)` (soa
 * cheatsheet diagnosis). Now each phase names the real culprit — the failing repo/step or DB.
 */
export function describeUpFailure(up: UpFailureView): string[] {
  if (up.mesh.conflicts.length > 0) {
    return ['mesh preflight FAILED — host port conflicts:', ...up.mesh.conflicts.map((c) => `  ✗ ${c.message}`)];
  }
  if (!up.mesh.makeOk) {
    return ['mesh bring-up FAILED (`make up` exited non-zero)'];
  }
  const downUnits = up.mesh.units.filter((u) => !u.ok).map((u) => u.id);
  if (downUnits.length > 0) {
    return [`mesh units never became ready: ${downUnits.join(', ')}`];
  }
  if (up.prep && !up.prep.ok) {
    const f = up.prep.failed;
    return [
      f
        ? `prep FAILED — \`pnpm ${f.argv.join(' ')}\` in ${f.repo}${f.detail ? ` (${f.detail})` : ''} exited non-zero — see the streamed output above`
        : 'prep FAILED — a build/install step exited non-zero; see the streamed output above',
    ];
  }
  if (up.provision && !up.provision.ok) {
    return [
      `DB provision FAILED${up.provision.failed ? ` on ${up.provision.failed}` : ''} — role/database create exited non-zero; see the streamed output above`,
    ];
  }
  if (up.migrate && !up.migrate.ok) {
    return [
      `migrate FAILED${up.migrate.failed ? ` on ${up.migrate.failed}` : ''} — \`prisma migrate\` exited non-zero; see the streamed output above`,
    ];
  }
  return [
    `service launch FAILED at ${up.failedAt ?? '(unknown)'} — ${up.failedReason ?? 'it never became healthy'}`,
  ];
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
/**
 * BLOCKER-1 launch-set narrowing for the sandbox/workspace cases (Phase 2). Absent
 * for a plain `--only`/bare `up`, so those closures are byte-identical.
 */
interface LaunchPrune {
  /** `--sandbox <name>`: launch the requested run-set ALONE (subtract the pulled-in deps). */
  sandboxHybrid?: boolean;
  /** `--workspace`: the mode:sandbox service ids to subtract (they live in the cloud). */
  sandboxServices?: ReadonlySet<ServiceId>;
  /** The sandbox name (`--sandbox` / workspace `iamSandbox`), surfaced in the dry-run prune line. */
  sandboxName?: string;
}
/** The subset `resolveWorkspace` reads (the mutual-exclusion + the file path). */
type WorkspaceParseFlags = {
  workspace?: string;
  only?: string;
  with?: string[];
  sandbox?: string;
};
/**
 * The subset `resolveOverlays` reads: the Phase-2 native overlay flags PLUS the
 * workspace/slot/state-dir flags the `--tunnel` fleet-config generation needs to
 * resolve the synthetic-dev + STATE dirs (`scriptContextFromFlags` + `deriveInstance`).
 */
type OverlayFlags = NativeFlags & {
  tunnel: boolean;
  record?: string;
};

/**
 * BLOCKER-1 (Phase 2): the sandbox/workspace LAUNCH prune, shared verbatim by
 * the dry-run projection and the native run (M15 dedup — they must never
 * drift, or the plan lies about what boots). `--sandbox` hybrid launches the
 * requested run-set ALONE (subtract pulled-in deps); a workspace supplies an
 * explicit sandbox-hosted service list. Plain `--only` closures are untouched.
 */
function sandboxDropSet(
  prune: LaunchPrune,
  requested: ServiceId[],
  closureServices: ServiceId[],
): Set<ServiceId> {
  const sandboxDrop = new Set<ServiceId>();
  if (prune.sandboxHybrid) {
    const keep = new Set<ServiceId>(requested);
    for (const id of closureServices) if (!keep.has(id)) sandboxDrop.add(id);
  }
  if (prune.sandboxServices) for (const id of prune.sandboxServices) sandboxDrop.add(id);
  return sandboxDrop;
}
