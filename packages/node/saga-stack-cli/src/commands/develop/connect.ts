/**
 * `saga-stack develop connect` — open a LIVE interactive Connect tutoring session (M5).
 *
 * Migrated from `e2e connect` (gh_305): dev-setup concierge commands live under the
 * `develop` topic; the old `e2e connect` id keeps working via a deprecating alias
 * (`static aliases`/`deprecateAliases` below).
 *
 * Replaces the M2 thin shell over connect-session.sh. It resolves the
 * `connect-session` flow from saga-dash's `flows.json` (bundled example until the
 * repo authors its own) and drives the SAME in-process orchestration as
 * `e2e run saga-dash/connect-session`: the resolver recurses the `journey`
 * prerequisite (built headless through `schedule`, owning the reset+seed), then
 * opens the headed `interactive-connect` Playwright project (1 tutor + 2 students
 * into a live Connect room). FOREGROUND: stdio is inherited so the AV hold owns
 * the user's TTY (needs connect-web + the AV stack + a real mic/cam).
 *
 * `--reuse` skips the prerequisite rebuild AND the reset, running the live session
 * against the CURRENT stack state (mirrors connect-session.sh `--reuse`). Anything
 * after `--` passes straight through to Playwright.
 *
 * `--fake-media` pins `FAKE_MEDIA=1` onto the headed interactive-connect run so
 * Chromium uses its synthetic camera/mic instead of real capture (mirrors
 * connect-session.sh `--fake-media`) — for a box with no camera or where
 * v4l2loopback won't build. The headless journey prerequisite is unaffected.
 *
 * SCOPE (plan §7.2 "M5"): the orchestration + headed run land here; AV-device /
 * post-session inspect polish is explicitly DEFERRED — the foreground hold is the
 * Playwright `page.pause()` in the spec, unchanged.
 *
 * `--refresh-snapshot` bakes the journey prerequisite checkpoints FRESH (a headless
 * replay through `schedule` with `--snapshot-stages`, i.e. `e2e run
 * saga-dash/journey --through schedule --snapshot-stages --headless`) BEFORE opening
 * the room, then the normal run restores that just-made checkpoint. It's the
 * one-command reseed for when the baked journey@schedule has gone stale (>7d cliff)
 * or the journey stages changed. Requires the default `--prereq-from-snapshot` (it
 * bakes so that path can restore); mutually exclusive with `--reuse`.
 *
 * `--bootstrap` (soa#329, with `--tunnel` only) automates docs/tunnel.md's
 * two-phase bridge before the room opens: phase 1 rebuilds usable state LOCALLY
 * and snapshots it (`tunnel-connect`); phase 2 relaunches the stack in tunnel
 * mode and restores it (one iam serves localhost OR the tunnel — never both).
 * Ledgered in `<stateDir>/bootstrap.json` (a failed run resumes); a fresh (<7d)
 * fixture skips phase 1 (`--rebuild` forces it). Implies `--reuse`.
 *
 *   node bin/dev.js develop connect
 *   node bin/dev.js develop connect --reuse -- --debug
 *   node bin/dev.js develop connect --fake-media
 *   node bin/dev.js develop connect --refresh-snapshot
 *   node bin/dev.js develop connect --tunnel --bootstrap
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { InstanceProfile } from '../../core/derive-instance.js';
import { resolveFlow } from '../../core/flow/index.js';
import type { ResolvedFlow } from '../../core/flow/index.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
import type { ScriptPlan } from '../../core/flag-map.js';
import { makeStackApi } from '../../stack-api.js';
import { bootstrapLedgerPath, makePersonaPreflight, resolveVendorScript } from '../../runtime/index.js';
import {
  buildStackContext,
  discoverFlowManifest,
  executeResolvedFlow,
  FlowExecError,
  resolveAppCwd,
  tunnelPersonaPreflight,
} from '../../e2e-orchestrate.js';
import type { ExecDeps, StackSeams } from '../../e2e-orchestrate.js';
import StackDown from '../stack/down.js';
import StackUp from '../stack/up.js';
import SnapshotRestore from '../stack/snapshot/restore.js';
import SnapshotStore from '../stack/snapshot/store.js';
import {
  BootstrapStepError,
  bootstrapResumeCommand,
  bootstrapWorkspaceArgv,
  runBootstrapSteps,
  tunnelFixtureFresh,
  TUNNEL_CONNECT_FIXTURE_ID,
} from '../../bootstrap-connect.js';
import type { BootstrapStep } from '../../bootstrap-connect.js';

/** The connect-session flow is a built-in saga-dash flow. */
const CONNECT_SPA = 'saga-dash';
const CONNECT_FLOW = 'connect-session';

export default class DevelopConnect extends BaseCommand {
  static description =
    'Open a live interactive Connect session: 1 tutor + 2 students (in-process; builds the journey prerequisite, then a headed Connect room).';

  // gh_305: `connect` migrated from the `e2e` topic to `develop`. Keep the old id
  // working for one cycle with a deprecation warning (@oclif/core ^4). Aliases use
  // the colon form in code; the topicSeparator (" ") means it is invoked as
  // `ss e2e connect`.
  static aliases = ['e2e:connect'];
  static deprecateAliases = true;

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --reuse -- --debug',
    '<%= config.bin %> <%= command.id %> --fake-media',
    '<%= config.bin %> <%= command.id %> --refresh-snapshot',
    '<%= config.bin %> <%= command.id %> --tunnel --bootstrap',
    '<%= config.bin %> <%= command.id %> --tunnel --bootstrap --rebuild --student-login 1',
  ];

  // Allow trailing playwright passthrough args (after `--`).
  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    reuse: Flags.boolean({
      description: 'skip the journey-prerequisite rebuild + reset; run the live session against the current stack state',
      default: false,
    }),
    'prereq-from-snapshot': Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'M14-C: restore the journey@schedule checkpoint (when a valid one is baked) instead of replaying the whole journey headless — the big Connect-session accelerant. Falls back to the replay when absent/invalid; --reuse trumps this entirely.',
    }),
    'refresh-snapshot': Flags.boolean({
      default: false,
      description:
        'bake the journey prerequisite checkpoints FRESH (headless replay through `schedule`, --snapshot-stages) BEFORE opening the room, then restore that just-made checkpoint — a one-command reseed for when the baked state has gone stale (>7d) or the journey changed. Deterministic fixtureIds ⇒ the bake overwrites. Requires --prereq-from-snapshot (the default); mutually exclusive with --reuse.',
    }),
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
    'fake-media': Flags.boolean({
      default: false,
      description:
        "swap real mic/cam capture for Chromium's synthetic camera (moving test pattern) + mic (beep) and auto-accept the getUserMedia prompt — for a machine with no camera or where v4l2loopback won't build. Sets FAKE_MEDIA=1 on the headed interactive-connect run (mirrors connect-session.sh --fake-media); the journey prerequisite is unaffected.",
    }),
    tunnel: Flags.boolean({
      default: false,
      description:
        'point THIS run’s Connect browsers at the vms tunnel hosts (https://<label>.<moniker>.<VMS_BASE>) instead of localhost, so a REMOTE peer can reach the same room. Resolves the moniker via the vendored tunnel.sh (same machinery as `stack up --tunnel`). Services ALREADY UP are reused untouched; any service this run must launch itself comes up WITH the tunnel browser-env overlay (soa#322). It does NOT start frpc or fetch LiveKit creds — run `ss stack up --tunnel` first for the tunnel itself (and real A/V). Slot-0 only.',
    }),
    'student-login': Flags.integer({
      default: 2,
      min: 0,
      max: 2,
      description:
        'how many of the 2 students THIS run logs in + joins locally (0, 1, or 2; default 2). The rest stay OPEN for a REMOTE peer to take — pair with --tunnel to invite coworkers. The tutor always auto-hosts and starts the session; login URLs for EVERY participant are printed regardless. Sets CONNECT_LOCAL_STUDENTS on the headed interactive-connect run.',
    }),
    bootstrap: Flags.boolean({
      default: false,
      description:
        "with --tunnel: automate docs/tunnel.md's two-phase bridge before opening the room. Phase 1 rebuilds usable state LOCALLY (down → up --seed full --reset → journey prerequisite → settle → snapshot store tunnel-connect); phase 2 relaunches in tunnel mode and restores it (down → up --tunnel --reset (hard stop if a foreign process survives) → snapshot restore → persona preflight). SKIPS phase 1 when a fresh (<7d) tunnel-connect fixture exists (--rebuild forces it). Progress is ledgered in <stateDir>/bootstrap.json, so a failed run RESUMES at the failed step; implies --reuse for the final session. Slot-0 only.",
    }),
    rebuild: Flags.boolean({
      default: false,
      description:
        'with --bootstrap: run the full phase-1 local rebuild even when a fresh (<7d) tunnel-connect fixture exists (the fast path would otherwise skip it).',
    }),
  };

  /**
   * `develop connect` brings up an isolated `soa-s<N>` connect sub-stack at slot > 0
   * — a live tutoring room is exactly the thing a dev wants off the shared slot 0.
   * It mirrors `e2e run` / `develop coach`: `deriveInstance` drives the offset
   * ports/DBs/mesh, the per-slot state dir, and the per-slot checkpoint root, and
   * the flow's Playwright children get the slot's own service URLs — so nothing is
   * pinned to slot 0. (See run(): the profile MUST reach buildStackContext and the
   * env seam MUST precede the checkpoint store, or this flag silently lies.)
   */
  protected slotAware(): boolean {
    return true;
  }

  /** Slot claims: the tutoring room brings up + DRIVES the slot's sub-stack — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(DevelopConnect);
    const passthrough = (argv as string[]).filter((a) => a !== CONNECT_FLOW);

    // ── soa#329 --bootstrap rejections FIRST (before any resolution/IO). Manual,
    // not oclif `exclusive:` — the M14 lesson (a defaulted value counts as
    // provided there). `--set` needs no check here: connect is not setAware(),
    // so BaseCommand.parse already rejected it above. ──
    if (flags.rebuild && !flags.bootstrap) {
      this.error(
        '--rebuild only modifies --bootstrap (it forces the full phase-1 rebuild past a fresh tunnel-connect fixture). Add --bootstrap or drop --rebuild.',
      );
    }
    if (flags.bootstrap) {
      if (!flags.tunnel) {
        this.error(
          "--bootstrap automates docs/tunnel.md's TWO-PHASE TUNNEL bridge — it is meaningless without --tunnel. Add --tunnel (or drop --bootstrap for a local session).",
        );
      }
      if (flags.slot > 0) {
        this.error(
          `slot ${flags.slot}: --bootstrap rebuilds slot 0's stack and snapshots/restores its tunnel bridge (the tunnel fronts the FIXED slot-0 browser ports), so it cannot run against a peer slot. Drop --slot.`,
        );
      }
      if (!flags['prereq-from-snapshot']) {
        this.error(
          '--bootstrap owns the prerequisite strategy (restore a usable checkpoint, else the local headless replay) — --no-prereq-from-snapshot would force the slow replay inside the bridge. Drop it.',
        );
      }
      if (flags['refresh-snapshot']) {
        this.error(
          '--bootstrap and --refresh-snapshot are mutually exclusive: phase 1 already rebuilds the state the bridge needs. Use --bootstrap --rebuild to force the full rebuild.',
        );
      }
    }

    // --bootstrap implies --reuse for the final hand-off: the phases below leave the
    // stack tunnel-mode with the tunnel-connect fixture restored — exactly the state
    // the reuse path runs against (rebuilding the prerequisite again would wipe it).
    const reuse = flags.reuse || flags.bootstrap;

    // --tunnel fronts the FIXED slot-0 browser ports via the vms rendezvous box, so
    // it is slot-0-only — mirroring `develop coach`, `e2e run --tunnel` and `stack up
    // --tunnel` (docs/tunnel.md). Guard BEFORE resolving the moniker below: without
    // it, `--tunnel --slot N` falls through and drives slot 0's tunnel hosts while
    // the rest of the run targets slot N.
    if (flags.tunnel && flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: --tunnel fronts the FIXED slot-0 browser ports via the vms rendezvous box, ` +
          'so it cannot run against a peer slot. Run develop connect at slot 0, or drop --tunnel.',
      );
    }

    // --refresh-snapshot bakes the journey prerequisite fresh, then restores it.
    // --reuse strips the prerequisite entirely (nothing to bake); --no-prereq-from-snapshot
    // would bake but never restore. Reject both up front (manual, not oclif `exclusive:`,
    // which treats a defaulted value as provided — the M14 lesson).
    if (flags['refresh-snapshot']) {
      if (flags.reuse) {
        this.error('--refresh-snapshot and --reuse are mutually exclusive: --reuse skips the prerequisite entirely, so there is nothing to bake.');
      }
      if (!flags['prereq-from-snapshot']) {
        this.error('--refresh-snapshot needs --prereq-from-snapshot (the default): it bakes the journey checkpoint so the live session can restore it. Drop --no-prereq-from-snapshot.');
      }
    }

    const disco = discoverFlowManifest(CONNECT_SPA, flags, process.env);
    if (disco.usedBundledExample) {
      this.warn(
        `no flows.json found for '${CONNECT_SPA}' in the repo; using the BUNDLED EXAMPLE shipped with @saga-ed/saga-stack-cli (${disco.sourcePath}).`,
      );
    }

    // Foreground + headed by default (the flow is `foreground:true`); --reuse drops
    // the prerequisite + reset entirely, exactly like connect-session.sh.
    const resolved = resolveFlow(disco.manifest, CONNECT_FLOW, { lane: 'stack' });
    const base = reuse ? { ...resolved, prerequisite: undefined } : resolved;
    // --fake-media (FAKE_MEDIA=1) and --student-login (CONNECT_LOCAL_STUDENTS=N) pin
    // env into THIS flow's env (merged last by computeEnv), so they reach only the
    // connect-session stage (headed interactive-connect) — not the journey
    // prerequisite, a separate ResolvedFlow.
    const stageEnv: Record<string, string> = {};
    if (flags['fake-media']) stageEnv.FAKE_MEDIA = '1';
    // Default (2) leaves the env unset ⇒ the spec's own default (all students local),
    // so a plain `e2e connect` is byte-identical to before. Only pin it when narrowing.
    if (flags['student-login'] !== 2) stageEnv.CONNECT_LOCAL_STUDENTS = String(flags['student-login']);
    const toRun =
      Object.keys(stageEnv).length > 0
        ? { ...base, flow: { ...base.flow, env: { ...base.flow.env, ...stageEnv } } }
        : base;

    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
    const now = new Date();

    // M7: resolve the slot profile once — it drives the offset ports/project/
    // container-env (buildStackContext), the launcher's per-slot state dir, the
    // checkpoint store's snapshot root, and the DB/mesh targeting so `--slot N`
    // provisions + migrates + seeds against slot N's OWN offset ports/DBs (mirrors
    // e2e run.ts). At slot 0 it is the byte-identical no-offset default. WITHOUT
    // this, `--slot N` would silently target slot 0.
    const profile = deriveInstance({ slot: flags.slot });
    // Apply the slot's container-env seam (mesh container names + snapshot dir) and
    // point the launcher at the slot's state dir (pids/logs) — both no-ops at slot 0.
    // ORDER-CRITICAL: the checkpoint store's resolvers read $SAGA_MESH_* when INVOKED,
    // so this call must land before any bake/restore below.
    this.applyInstanceEnv(profile);
    const stateDir = flags['state-dir'] ?? profile.stateDir;

    const seams = {
      launcher: this.getLauncher(stateDir),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      // soa#300: coach-web `.env.local` prelaunch seam — harmless here (coach-web is not
      // in the connect closure), wired for parity with the other bring-up paths.
      coachWebFs: this.getCoachWebFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
      // Native-prep seams: buildStackContext wires them into the runtime at EVERY
      // slot so StackApi.up runs R2 provision + R3 migrate on the slot's offset DBs
      // before launch+seed (mirrors e2e run.ts — required for a slot > 0 bring-up,
      // whose DBs do not exist yet). StackApi gates the whole native-prep pass on
      // `runtime.pgProbe`, so omitting these silently skips provision + migrate.
      pgProbe: this.getPgProbe(),
      prepIsFresh: this.getPrepFreshCheck(),
      prepWriteStamp: this.getPrepStampWriter(),
      prepRepairDeps: this.getPrepDepRepairer(),
      prepDbGenerateScan: this.getDbGenerateScan(),
      repoDirExists: this.getRepoDirCheck(),
    };
    const delegate = (plan: ScriptPlan): Promise<number> =>
      this.runScript(plan, flags as WorkspaceFlags, { propagateExit: false });

    // --tunnel: resolve <moniker>.<VMS_BASE> from the VENDORED tunnel.sh (the SAME
    // machinery as `stack up --tunnel`, up.ts:297-303) so the headed Connect room
    // drives the tunnel hosts. Guarded slot-0-only above (the tunnel fronts fixed
    // slot-0 ports). The seam lets unit tests inject a fixed moniker instead of
    // spawning tunnel.sh.
    let tunnelDomain: string | undefined;
    if (flags.tunnel) {
      const vmsBase = process.env.VMS_BASE ?? 'vms.wootdev.com';
      const moniker = await this.getTunnelMoniker()(resolveVendorScript('tunnel.sh'));
      tunnelDomain = `${moniker}.${vmsBase}`;
    }

    const { runtime } = buildStackContext(flags, seams, delegate, profile, tunnelDomain);
    const api = makeStackApi(serviceManifest, runtime);

    // ── soa#329 --bootstrap: run the two-phase bridge BEFORE the live session.
    // On success the stack is up in TUNNEL mode with the tunnel-connect fixture
    // restored — exactly the state the --reuse hand-off below runs against.
    // tunnelDomain is guaranteed here (--bootstrap requires --tunnel, rejected
    // above), so the room's browsers drive the tunnel hosts. ──
    if (flags.bootstrap) {
      await this.runBootstrapPhases({
        flags,
        resolved,
        appCwd,
        now,
        seams,
        delegate,
        profile,
        stateDir,
        tunnelDomain: tunnelDomain as string,
      });
    }

    // M14-C: the checkpoint store so the journey prerequisite can be RESTORED
    // instead of replayed (--reuse strips the prerequisite entirely, so nothing to
    // restore there). Also needed for --refresh-snapshot's fresh bake.
    //
    // ORDER-CRITICAL — `applyInstanceEnv(profile)` MUST precede the first store CALL.
    // The store's resolvers read `$SAGA_MESH_SNAPSHOTS_DIR` / `$SAGA_MESH_*_CONTAINER`
    // when INVOKED, not when built (runtime/checkpoint-store.ts "CALL-TIME ENV
    // CONTRACT", snapshot-store.ts `snapshotsRoot()`); `applyInstanceEnv` is what points
    // them at the slot's root (`~/.saga-mesh/snapshots-s<N>`). Constructing it here —
    // after that call, before any bake/restore — keeps the invariant trivially true.
    // Break it and EVERY slot falls back to the SHARED `~/.saga-mesh/snapshots`: two
    // concurrent slots bake/restore the SAME journey@schedule checkpoint — on-disk data
    // corruption, not a port clash. `connect.int.test.ts` pins the ordering.
    //
    // The other root input is `scriptContextFromFlags(flags)` — the `--<repo>` path
    // pins the schema-ahead guard resolves local migrations from. It is flag-derived,
    // not env-derived, so it is order-independent. (`--set` would pin repo paths AND
    // a slot ≥ 1, but connect is not `setAware()`, so parse rejects it.)
    const checkpoints =
      toRun.prerequisite !== undefined && (flags['prereq-from-snapshot'] || flags['refresh-snapshot'])
        ? this.getCheckpointStore(this.scriptContextFromFlags(flags))
        : undefined;

    // --refresh-snapshot: bake the prerequisite's stage checkpoints FRESH before the
    // live session — a headless full replay of journey 1..schedule with --snapshot-stages,
    // exactly `ss e2e run saga-dash/journey --through schedule --snapshot-stages --headless`.
    // Deterministic fixtureIds ⇒ the bake OVERWRITES any stale checkpoint; the main run
    // below then restores the just-made journey@schedule (prereq-from-snapshot path).
    if (flags['refresh-snapshot'] && toRun.prerequisite !== undefined) {
      const prereq = toRun.prerequisite;
      // M14 §2.3 (advisory): stamp the SPA checkout HEAD into the bake so a later
      // restore can WARN on drift. '' sha (not a git checkout) ⇒ omitted.
      let spaHead: { sha: string; dirty: boolean } | undefined;
      const spaRepoRoot = appCwd.slice(0, appCwd.length - resolved.spa.appDir.length - 1);
      const git = this.getGitRunner();
      const sha = await git.headSha(spaRepoRoot);
      if (sha !== '') spaHead = { sha, dirty: (await git.statusPorcelain(spaRepoRoot)).trim() !== '' };

      this.log(
        `==> refresh-snapshot: baking ${prereq.flow.name}@${prereq.stages.at(-1)?.id} checkpoints (headless replay, --snapshot-stages)…`,
      );
      try {
        const bakeCode = await executeResolvedFlow(
          prereq,
          // The bake is a headless replay against THIS slot's stack, so it needs the
          // same slot-offset ports as the main run below — otherwise its Playwright
          // children mint against the base iam and bake a slot-0-shaped checkpoint.
          {
            api,
            runner: seams.runner,
            appCwd,
            now,
            log: (l) => this.log(l),
            slot: profile.slot,
            ports: runtime.launchContext.ports,
            checkpoints,
            // soa#327: the fresh bake must wait out the roster-sync pipeline
            // before each per-stage dump — this bake path exists precisely to
            // produce the checkpoint the tunnel session will trust.
            settleBarrier: this.getSettleBarrier(profile.slot, (l) => this.log(l)),
          },
          { lane: 'stack', skipReset: false, passthrough: [], snapshotStages: true, prereqFromSnapshot: false, spaHead },
        );
        if (bakeCode !== 0) this.error(`--refresh-snapshot: prerequisite bake failed (exit ${bakeCode}).`);
      } catch (err) {
        if (err instanceof FlowExecError) this.error(`--refresh-snapshot: ${err.message}`);
        throw err;
      }
    }

    try {
      const code = await executeResolvedFlow(
        toRun,
        // Pass the SLOT-OFFSET ports (mirrors e2e run) so the Playwright spawns get
        // PLAYWRIGHT_IAM_URL/_CONNECT_URL/_CONNECT_API_URL for THIS slot. Without
        // `ports`, playwrightEnv skips serviceUrlEnv entirely and the specs' lane.ts
        // falls back to the hardcoded base ports (iam :3010, connect :6210) — the
        // room boots against slot 0 (soa#300 tail). Deps ride through the
        // prerequisite recursion, so the journey prerequisite inherits them.
        {
          api,
          runner: seams.runner,
          appCwd,
          now,
          log: (l) => this.log(l),
          slot: profile.slot,
          ports: runtime.launchContext.ports,
          checkpoints,
          tunnelDomain,
          // soa#327: the tunnel post-restore devLogin probe — a --tunnel session
          // whose journey@schedule checkpoint restored TORN must fail loud here,
          // before the room's browsers launch and 401 minutes later.
          preflight: makePersonaPreflight({
            poster: this.getCookiePoster(),
            log: (l) => this.log(l),
            sleep: this.getSleep(),
          }),
        },
        {
          lane: 'stack',
          skipReset: reuse,
          passthrough,
          prereqFromSnapshot: flags['prereq-from-snapshot'],
        },
      );
      if (code !== 0) this.exit(code);
    } catch (err) {
      if (err instanceof FlowExecError) this.error(err.message);
      throw err;
    }
  }

  /**
   * soa#329: the --bootstrap two-phase bridge. Builds the step list (phase 1 is
   * dropped entirely on the fast path — a fresh <7d tunnel-connect fixture; the
   * ledger separately skips steps a previous FAILED run completed) and hands it
   * to the sequencer. The steps compose EXISTING machinery only: the stack/
   * snapshot sub-commands (forwarded the same workspace argv, the `stack
   * bootstrap` precedent), the in-process flow orchestrator for the prerequisite,
   * and the soa#327 settle-barrier/preflight seams.
   */
  private async runBootstrapPhases(ctx: {
    flags: WorkspaceFlags & Record<string, unknown> & { 'state-dir'?: string; rebuild: boolean };
    resolved: ResolvedFlow;
    appCwd: string;
    now: Date;
    seams: StackSeams;
    delegate: (plan: ScriptPlan) => Promise<number>;
    profile: InstanceProfile;
    stateDir: string;
    tunnelDomain: string;
  }): Promise<void> {
    const { flags, resolved, profile, now, stateDir, tunnelDomain } = ctx;
    const prereq = resolved.prerequisite;
    if (prereq === undefined) {
      this.error(
        `--bootstrap: flow '${CONNECT_FLOW}' declares no prerequisite — there is no journey state to bake into the '${TUNNEL_CONNECT_FIXTURE_ID}' fixture.`,
      );
    }
    const terminalStage = prereq.stages.at(-1)?.id ?? '';

    // The checkpoint store doubles as the fixture-manifest reader (fast path) and
    // the prerequisite's restore source. Built AFTER applyInstanceEnv (run() did,
    // before calling this) — the store's resolvers read $SAGA_MESH_* at CALL time.
    const store = this.getCheckpointStore(this.scriptContextFromFlags(flags));

    // FAST-PATH input: a fresh (<7d) tunnel-connect fixture makes phase 1 pure
    // waste — phase 2 restores the fixture anyway. The DECISION sits below the
    // step lists: it must also consult the ledger (an in-flight phase-1 rebuild
    // must resume, never be fast-pathed over).
    const fixture = store.load(TUNNEL_CONNECT_FIXTURE_ID);
    const fresh = tunnelFixtureFresh(fixture, now);

    // PHASE-1 stack context: NO tunnelDomain. Phase 1 rebuilds state against
    // localhost — anything IT launches must get the plain local browser env, and
    // the prerequisite must keep the LOCAL lane's restore-else-replay fallback
    // (the tunnel fail-loud gates key off deps.tunnelDomain).
    const { runtime: localRuntime } = buildStackContext(flags, ctx.seams, ctx.delegate, profile);
    const localApi = makeStackApi(serviceManifest, localRuntime);
    const localDeps: ExecDeps = {
      api: localApi,
      runner: ctx.seams.runner,
      appCwd: ctx.appCwd,
      now,
      log: (l) => this.log(l),
      slot: profile.slot,
      ports: localRuntime.launchContext.ports,
      checkpoints: store,
    };

    // The workspace argv every sub-command step gets, so down/up/store/restore
    // resolve the SAME checkouts + state dir this run did.
    const ws = bootstrapWorkspaceArgv(flags);

    const phase1: BootstrapStep[] = [
      {
        id: 'local-down',
        title: 'phase 1 — stack down (clean local relaunch)',
        run: async () => void (await StackDown.run([...ws], this.config)),
      },
      {
        id: 'local-up',
        title: 'phase 1 — stack up --seed full --reset (local baseline)',
        run: async () => void (await StackUp.run(['--seed', 'full', '--reset', ...ws], this.config)),
      },
      {
        id: 'prerequisite',
        title: `phase 1 — journey prerequisite through '${terminalStage}' (checkpoint restore if usable, else headless replay; retry-once on stage flake)`,
        run: () => this.runBootstrapPrerequisite(resolved, localDeps),
      },
      {
        id: 'settle',
        title: 'phase 1 — settle barrier (roster-sync drain + persona devLogin)',
        run: async () => {
          await this.getSettleBarrier(profile.slot, (l) => this.log(l))({
            fixtureId: TUNNEL_CONNECT_FIXTURE_ID,
            stageId: terminalStage,
            personas: prereq.flow.settlePersonas ?? [],
          });
        },
      },
      {
        id: 'snapshot-store',
        title: `phase 1 — snapshot store --fixture-id ${TUNNEL_CONNECT_FIXTURE_ID} --force`,
        run: async () =>
          void (await SnapshotStore.run(
            ['--fixture-id', TUNNEL_CONNECT_FIXTURE_ID, '--profile', 'full', '--force', ...ws],
            this.config,
          )),
      },
    ];

    const phase2: BootstrapStep[] = [
      {
        id: 'tunnel-down',
        title: 'phase 2 — stack down (every service must RELAUNCH with the tunnel env)',
        run: async () => void (await StackDown.run([...ws], this.config)),
      },
      {
        id: 'tunnel-up',
        title: 'phase 2 — stack up --tunnel --reset (hard stop if a foreign process survived)',
        run: async () =>
          void (await StackUp.run(['--tunnel', '--reset', '--forbid-foreign', ...ws], this.config)),
      },
      {
        id: 'snapshot-restore',
        title: `phase 2 — snapshot restore ${TUNNEL_CONNECT_FIXTURE_ID}`,
        run: async () => void (await SnapshotRestore.run([TUNNEL_CONNECT_FIXTURE_ID, ...ws], this.config)),
      },
      {
        id: 'persona-preflight',
        title: 'phase 2 — persona preflight (devLogin over the tunnel iam host, soa#331)',
        run: async () => {
          await tunnelPersonaPreflight(prereq.flow, {
            ...localDeps,
            tunnelDomain,
            preflight: makePersonaPreflight({
              poster: this.getCookiePoster(),
              log: (l) => this.log(l),
              sleep: this.getSleep(),
            }),
          });
        },
      },
    ];

    // FAST-PATH decision. A ledger recording completed PHASE-1 steps means a
    // rebuild is mid-flight from a failed run: the fast path would discard it —
    // restore the OLD fixture the user asked to replace and clear the ledger as
    // "success" — so an in-flight rebuild always disables the fast path. The
    // resume command mirrors this run's shape (--rebuild + workspace pins); the
    // bare base command would not resume under a custom --state-dir.
    const ledgerIO = this.getBootstrapLedgerIO();
    const ledgerPath = bootstrapLedgerPath(stateDir);
    const phase1Ids = new Set(phase1.map((s) => s.id));
    const rebuildInFlight = (ledgerIO.read(ledgerPath)?.completed ?? []).some((id) =>
      phase1Ids.has(id),
    );
    const skipPhase1 = fresh && !flags.rebuild && !rebuildInFlight;
    if (skipPhase1) {
      this.log(
        `==> bootstrap FAST PATH: fixture '${TUNNEL_CONNECT_FIXTURE_ID}' is fresh (created ${fixture?.createdAt}) — skipping phase 1 (--rebuild forces the full rebuild)`,
      );
    } else if (fresh && flags.rebuild) {
      this.log(
        `==> bootstrap: --rebuild — ignoring the fresh '${TUNNEL_CONNECT_FIXTURE_ID}' fixture; running the full phase-1 rebuild`,
      );
    } else if (fresh && rebuildInFlight) {
      this.log(
        `==> bootstrap: ledger records an in-flight phase-1 rebuild — resuming it past the fresh '${TUNNEL_CONNECT_FIXTURE_ID}' fixture`,
      );
    }

    try {
      await runBootstrapSteps(skipPhase1 ? phase2 : [...phase1, ...phase2], {
        ledger: ledgerIO,
        ledgerPath,
        log: (l) => this.log(l),
        now,
        resumeCommand: bootstrapResumeCommand(flags),
      });
    } catch (err) {
      if (err instanceof BootstrapStepError) this.error(err.message);
      throw err;
    }
    this.log('✓ bootstrap complete — two-phase bridge up; handing off to the live session (--reuse).');
  }

  /**
   * Phase-1 'prerequisite' step: put the LOCAL stack into the journey@schedule
   * end-state via the EXISTING orchestrator. Executes a stages-empty variant of
   * the connect-session flow, so executeResolvedFlow's own prerequisite handling
   * supplies the strategy — restore the baked journey@schedule checkpoint when
   * one is usable, else the full headless replay (local lane ⇒ silent fallback)
   * — then up+verify the connect closure and stop before any Playwright spawn
   * (`stages: []` is the Plan-13 empty window). One retry on failure: a single
   * failed journey stage is the known async-settle flake class (soa#327).
   */
  private async runBootstrapPrerequisite(resolved: ResolvedFlow, deps: ExecDeps): Promise<void> {
    const stateOnly: ResolvedFlow = { ...resolved, stages: [], reset: false, seedSelection: undefined };
    const attempt = (): Promise<number> =>
      executeResolvedFlow(stateOnly, deps, {
        lane: 'stack',
        skipReset: false,
        passthrough: [],
        prereqFromSnapshot: true,
      });

    try {
      const code = await attempt();
      if (code === 0) return;
      this.log(`⚠ bootstrap prerequisite exited ${code} — retrying once (known async-settle stage-flake class)`);
    } catch (err) {
      if (!(err instanceof FlowExecError)) throw err;
      this.log(
        `⚠ bootstrap prerequisite failed — retrying once (known async-settle stage-flake class):\n${err.message}`,
      );
    }

    const code = await attempt();
    if (code !== 0) {
      throw new Error(`prerequisite failed twice (exit ${code}) — not the retry-once flake class`);
    }
  }
}
