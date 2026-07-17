/**
 * `saga-stack develop session-adm` — the live SESSION-attendance ADM demo as a
 * durable concierge (gh session-adm plan, claude/projects/ss-develop-session-adm-plan.md).
 *
 * Promotes saga-dash's `telemetry-demo-multi.sh` into the `develop` family: a
 * tutor (alex.tutor) + Alex's 3 pod-A students (ann.lee / cara.diaz / gina.park)
 * join a real Connect room STAGGERED, each running the real connectv3
 * `SessionHeartbeat`; ads-adm accrues TELEMETRY dosage live; closing one
 * student's window freezes ONLY that counter. Multi-only v1 by decision — the
 * single-student sibling stays reachable via `ss e2e run saga-dash/connect-session-dosage`.
 *
 * It resolves the `connect-session-demo` flow from saga-dash's `flows.json`
 * (bundled example fallback) and drives the SAME in-process orchestration as
 * `e2e run`, folding the concierge script's sequence in:
 *
 *   1. `stack down` (unless `--reuse`) — LOAD-BEARING: saga-dash + connect-web
 *      must RELAUNCH so the demo env below reaches their dev servers (an
 *      already-up server is adopted untouched and keeps its stale env).
 *   2. Pin the demo env into `process.env` — the launcher spawns every service
 *      with `{ ...process.env, ...launchEnv }`, so this is the supported
 *      per-invocation service-env seam (the coach `ARCHIVE_DIR` precedent):
 *      `VITE_DASH_LIVE_SESSIONS` + `VITE_DEMO_LIVE_ATTENDANCE` (live dash
 *      polling) and `VITE_CONNECTV3_HEARTBEAT_INTERVAL_MS=3000` (fast pings,
 *      qboard#298). The `ADS_ADM_*` session-source gates are NOT re-injected —
 *      soa#346 baked them into the ads-adm-api manifest env + adoption guard.
 *   3. Bring-up window: the journey@attendance prerequisite (checkpoint restore
 *      when baked, else headless replay — owning the reset+seed) + up/verify of
 *      the demo closure, via a stages-empty `executeResolvedFlow` (the Plan-13
 *      empty window, same as connect's bootstrap prerequisite step).
 *   4. Unless `--no-admin`: mint the admin jar (empty@saga.org, slot-aware iam)
 *      and open the vendored logged-in browser at
 *      `/dashboard/attendance?mode=session` — UN-awaited, BEFORE the held run
 *      (every exit path then AWAITS the window or ABORTS the child: held-success
 *      waits, --no-hold and the failure paths kill it — never an orphan).
 *      The shell script could only open the admin dash after grepping its log
 *      for the spec's `[DEMO] Dosage landed` sentinel; in-process the Runner has
 *      no output capture, and the spec's DEMO_HOLD pre-join pause (20s) exists
 *      precisely so an ALREADY-OPEN admin dash watches the counters climb from
 *      zero — strictly better demo choreography, zero new machinery.
 *   5. The held demo run: headed foreground Playwright (the flow is
 *      `foreground:true`), stdio inherited, with `DEMO_HOLD=1` (drop via
 *      `--no-hold`) + `DEMO_STAGGER_MS` (default 15000 — the ADVERTISED 15s
 *      cadence; the spec's own default is 6s) pinned onto THIS flow's env only
 *      (merged last by computeEnv — the journey prerequisite is unaffected).
 *      The spec itself polls ads-adm for fresh TELEMETRY dosage and prints
 *      `[DEMO] Dosage landed`, then holds every window open via the Playwright
 *      Inspector — Resume (▶) ends the run. Ctrl-C reaches the inherited-stdio
 *      Playwright child and the admin browser (same process group); the stack's
 *      detached services stay up (`ss stack down` when done — printed).
 *
 * AV: the LiveKit/coturn pair is the SHARED slot-0 docker pair and this command
 * does not start it (`ss stack up` at slot 0 does, best-effort) — at `--slot N`
 * the non-AV mechanics all run against slot N, but media needs slot 0's AV
 * containers already up. Media capture is ALWAYS synthetic: the
 * `connect-session-demo` Playwright project HARDCODES Chromium's fake cam/mic
 * (+ --mute-audio) in its launchOptions, so a camera-less box needs nothing —
 * `--fake-media` is accepted only for develop-family muscle-memory (a no-op
 * here; unlike `develop connect`, nothing in this project reads FAKE_MEDIA).
 *
 *   node bin/dev.js develop session-adm
 *   node bin/dev.js develop session-adm --reuse --no-admin
 *   node bin/dev.js develop session-adm --stagger-ms 6000 -- --debug
 *   node bin/dev.js develop session-adm --refresh-snapshot
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { resolveFlow } from '../../core/flow/index.js';
import type { ResolvedFlow } from '../../core/flow/index.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
import type { ScriptPlan } from '../../core/flag-map.js';
import { makeStackApi } from '../../stack-api.js';
import {
  bakePrerequisiteCheckpoints,
  buildStackContext,
  discoverFlowManifest,
  executeResolvedFlow,
  FlowExecError,
  resolveAppCwd,
} from '../../e2e-orchestrate.js';
import type { ExecDeps } from '../../e2e-orchestrate.js';
import StackDown from '../stack/down.js';
import { bootstrapWorkspaceArgv } from '../../bootstrap-connect.js';

/** The demo flow is a built-in saga-dash flow. */
const DEMO_SPA = 'saga-dash';
const DEMO_FLOW = 'connect-session-demo';

/** The admin persona the hand-off browser logs in (script parity: $ADMIN_EMAIL). */
const DEFAULT_ADMIN_EMAIL = 'empty@saga.org';

/** The admin view: SESSION-mode attendance (script parity: LOGIN_DASH_URL). */
const ADMIN_DASH_PATH = '/dashboard/attendance?mode=session';

/**
 * connectv3 heartbeat cadence for the demo (qboard#298 test hook): 3s instead of
 * the 60s production interval, so the 2nd self-report ping — the spec's
 * freshness gate — lands within seconds of a join.
 */
const HEARTBEAT_INTERVAL_MS = 3000;

export default class DevelopSessionAdm extends BaseCommand {
  static description =
    'Run the live SESSION-attendance ADM demo: 3 staggered Connect students self-report telemetry dosage onto an auto-opened admin attendance dash (in-process; journey prerequisite, then a held headed room).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --reuse --no-admin',
    '<%= config.bin %> <%= command.id %> --stagger-ms 6000 -- --debug',
    '<%= config.bin %> <%= command.id %> --refresh-snapshot',
  ];

  // Allow trailing playwright passthrough args (after `--`).
  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    reuse: Flags.boolean({
      default: false,
      description:
        'skip the stack down + journey-prerequisite rebuild + reset; run the demo against the CURRENT stack state. CAVEAT: the demo VITE env only reaches services THIS run launches — an already-up saga-dash/connect-web is adopted untouched, so live polling / the 3s heartbeat need the stack to have been brought up by a previous session-adm run.',
    }),
    'prereq-from-snapshot': Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'restore the journey@attendance checkpoint (when a valid one is baked) instead of replaying the whole journey headless — the big accelerant (mirrors develop connect). Falls back to the replay when absent/invalid; --reuse trumps this entirely.',
    }),
    'refresh-snapshot': Flags.boolean({
      default: false,
      description:
        'bake the journey prerequisite checkpoints FRESH (headless replay through `attendance`, --snapshot-stages) BEFORE the demo, then restore that just-made checkpoint — the one-command reseed for a stale (>7d) or drifted journey (and the remedy for the pod-A roster-drift guard). Requires --prereq-from-snapshot (the default); mutually exclusive with --reuse.',
    }),
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
    'fake-media': Flags.boolean({
      default: false,
      description:
        "NO-OP for this demo, accepted only for develop-family muscle-memory: the connect-session-demo Playwright project HARDCODES Chromium's synthetic camera + mic (+ --mute-audio) in its launchOptions, so the demo NEVER captures real devices — with or without this flag. (Unlike develop connect, where FAKE_MEDIA=1 is load-bearing.) Still pins FAKE_MEDIA=1 on the demo spawn; nothing in that project reads it.",
    }),
    admin: Flags.boolean({
      default: true,
      allowNo: true,
      description:
        `auto-open the vendored logged-in admin browser (${DEFAULT_ADMIN_EMAIL}, override via $ADMIN_EMAIL) at ${ADMIN_DASH_PATH} once the stack is ready, BEFORE the students join — the pre-join hold exists so the counters visibly climb from zero. --no-admin skips it and prints the manual login one-liner instead (script parity).`,
    }),
    hold: Flags.boolean({
      default: true,
      allowNo: true,
      description:
        'hold the demo open for a presenter (DEMO_HOLD=1): a 20s pre-join pause (open the admin dash now), then after dosage lands every window stays open via the Playwright Inspector — close one student window to freeze its counter, Resume (▶) to end. --no-hold drops the pauses for a CI-ish straight-through run (the auto-opened admin browser is closed at the end instead of holding the terminal).',
    }),
    'stagger-ms': Flags.integer({
      default: 15000,
      min: 0,
      description:
        "gap between student joins (DEMO_STAGGER_MS). Default 15000 — the demo's advertised 15s cadence, pinned EXPLICITLY because the spec's own fallback is 6s.",
    }),
  };

  /**
   * `develop session-adm` brings up an isolated `soa-s<N>` demo sub-stack at
   * slot > 0 — the non-AV mechanics (journey prerequisite, demo env, dosage,
   * admin hand-off) all run against slot N (dev-test posture: slot 1). ONLY the
   * AV media plane is slot-0-pinned: LiveKit/coturn are the shared slot-0
   * containers (`stack-api` gates their bring-up on slot 0), so a slot-N room
   * gets media only while slot 0's AV pair is already up — warned in run().
   */
  protected slotAware(): boolean {
    return true;
  }

  /** Slot claims: the demo brings up + DRIVES the slot's sub-stack — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(DevelopSessionAdm);
    const passthrough = argv as string[];

    // --refresh-snapshot rejections FIRST (manual, not oclif `exclusive:` — a
    // defaulted value counts as provided there; the M14 lesson).
    if (flags['refresh-snapshot']) {
      if (flags.reuse) {
        this.error('--refresh-snapshot and --reuse are mutually exclusive: --reuse skips the prerequisite entirely, so there is nothing to bake.');
      }
      if (!flags['prereq-from-snapshot']) {
        this.error('--refresh-snapshot needs --prereq-from-snapshot (the default): it bakes the journey checkpoint so the demo can restore it. Drop --no-prereq-from-snapshot.');
      }
    }

    const disco = discoverFlowManifest(DEMO_SPA, flags, process.env);
    if (disco.usedBundledExample) {
      this.warn(
        `no flows.json found for '${DEMO_SPA}' in the repo; using the BUNDLED EXAMPLE shipped with @saga-ed/saga-stack-cli (${disco.sourcePath}).`,
      );
    }

    // Foreground + headed by default (the flow is `foreground:true`); --reuse
    // drops the prerequisite + reset entirely (mirrors develop connect).
    const resolved = resolveFlow(disco.manifest, DEMO_FLOW, { lane: 'stack' });
    const base = flags.reuse ? { ...resolved, prerequisite: undefined } : resolved;

    // Playwright-process knobs, pinned into THIS flow's env (merged last by
    // computeEnv) so they reach ONLY the demo spec — never the journey
    // prerequisite, a separate ResolvedFlow. DEMO_STAGGER_MS is ALWAYS pinned:
    // the advertised cadence is 15s but the spec's own fallback is 6s, so
    // relying on the default would silently under-stagger (the shell script's
    // known gap).
    const stageEnv: Record<string, string> = {
      DEMO_STAGGER_MS: String(flags['stagger-ms']),
    };
    if (flags.hold) stageEnv.DEMO_HOLD = '1';
    // Documented no-op (see the flag): the demo project hardcodes synthetic media
    // and reads no FAKE_MEDIA — pinned anyway so the env mirrors the user's intent.
    if (flags['fake-media']) stageEnv.FAKE_MEDIA = '1';
    const toRun: ResolvedFlow = { ...base, flow: { ...base.flow, env: { ...base.flow.env, ...stageEnv } } };

    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
    const now = new Date();

    // M7: resolve the slot profile once — offset ports/project/container-env,
    // per-slot state dir, per-slot checkpoint root (mirrors e2e run / connect).
    // WITHOUT this, `--slot N` would silently target slot 0.
    const profile = deriveInstance({ slot: flags.slot });
    // ORDER-CRITICAL: the checkpoint store's resolvers read $SAGA_MESH_* when
    // INVOKED, so this must land before any bake/restore below.
    this.applyInstanceEnv(profile);
    const stateDir = flags['state-dir'] ?? profile.stateDir;

    // AV doctrine (post-soa#271 nuance): connect-api/connect-web DO run at
    // slot > 0 — only the AV MEDIA plane (LiveKit/coturn bring-up) is pinned to
    // slot 0. Warn, don't error: slot > 0 is the supported dev-test posture for
    // everything non-AV; the held AV demo itself validates at slot 0.
    if (flags.slot > 0) {
      this.warn(
        `slot ${flags.slot}: AV stays on slot 0 — this slot's room reuses the SHARED slot-0 LiveKit/coturn ` +
          'containers (started by `ss stack up` at slot 0, not by this command). Without them the room is ' +
          'CRDT-only (no media), heartbeats never start, and dosage never lands. Non-AV mechanics all run on this slot.',
      );
    }

    const seams = {
      launcher: this.getLauncher(stateDir),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      // soa#300: coach-web `.env.local` prelaunch seam — harmless here (coach-web
      // is not in the demo closure), wired for parity with the other bring-up paths.
      coachWebFs: this.getCoachWebFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
      // Native-prep seams: R2 provision + R3 migrate on the slot's offset DBs
      // before launch+seed — required for a slot > 0 bring-up (mirrors connect).
      pgProbe: this.getPgProbe(),
      prepIsFresh: this.getPrepFreshCheck(),
      prepWriteStamp: this.getPrepStampWriter(),
      prepRepairDeps: this.getPrepDepRepairer(),
      prepDbGenerateScan: this.getDbGenerateScan(),
      repoDirExists: this.getRepoDirCheck(),
    };
    const delegate = (plan: ScriptPlan): Promise<number> =>
      this.runScript(plan, flags as WorkspaceFlags, { propagateExit: false });

    const { runtime } = buildStackContext(flags, seams, delegate, profile);
    const api = makeStackApi(serviceManifest, runtime);

    // ── 1. stack down (unless --reuse) — LOAD-BEARING (script step 1): an
    // already-up saga-dash/connect-web would be ADOPTED untouched (their
    // adoptEnv fingerprints don't cover the demo keys), silently keeping stale
    // env. Down forces the relaunch that inherits the demo env below. The
    // in-process sub-command precedent is connect's bootstrap 'local-down'. ──
    if (!flags.reuse) {
      this.log('==> stack down — saga-dash + connect-web must RELAUNCH with the demo env (skip with --reuse)…');
      await StackDown.run(['--slot', String(flags.slot), ...bootstrapWorkspaceArgv(flags)], this.config);
    } else {
      this.warn(
        '--reuse: skipping the stack down — the demo VITE env (live polling + 3s heartbeat) only reaches ' +
          'services THIS run launches; an already-up saga-dash/connect-web keeps whatever env it booted with.',
      );
    }

    // ── 2. the demo SERVICE env — the launcher spawns every service with
    // `{ ...process.env, ...launchEnv }` (up.sh `env "$@"` parity), so
    // process-env inheritance is the supported per-invocation seam (the coach
    // ARCHIVE_DIR/DATABASE_URL precedent). Verified collision-free: no manifest
    // launch.env or adoptEnv key overlaps these three. The ADS_ADM_* session
    // gates are DELIBERATELY not set — soa#346 baked them into the ads-adm-api
    // manifest env + adoption fingerprint; re-injecting would just shadow it. ──
    process.env.VITE_DASH_LIVE_SESSIONS = 'true';
    process.env.VITE_DEMO_LIVE_ATTENDANCE = 'true';
    process.env.VITE_CONNECTV3_HEARTBEAT_INTERVAL_MS = String(HEARTBEAT_INTERVAL_MS);

    // M14-C: the checkpoint store so the journey prerequisite can be RESTORED
    // instead of replayed. ORDER-CRITICAL: constructed AFTER applyInstanceEnv
    // (call-time env contract) — same invariant connect.int.test.ts pins.
    const checkpoints =
      toRun.prerequisite !== undefined && (flags['prereq-from-snapshot'] || flags['refresh-snapshot'])
        ? this.getCheckpointStore(this.scriptContextFromFlags(flags))
        : undefined;

    const deps: ExecDeps = {
      api,
      runner: seams.runner,
      appCwd,
      now,
      log: (l) => this.log(l),
      // Slot + OFFSET ports (mirrors e2e run) so every Playwright spawn — the
      // prerequisite's and the demo's — mints against THIS slot's iam and
      // drives its service URLs (the soa#300 tail). Ride the recursion via deps.
      slot: profile.slot,
      ports: runtime.launchContext.ports,
      checkpoints,
    };

    // --refresh-snapshot: bake the prerequisite's stage checkpoints FRESH before
    // the demo — a headless replay of journey 1..attendance with --snapshot-stages
    // (the SHARED helper connect's bake also drives, one stage further here).
    // Deterministic fixtureIds ⇒ the bake OVERWRITES any stale checkpoint; the
    // bring-up below restores it. The settle barrier (soa#327) is REQUIRED by the
    // helper's type — this bake exists precisely to produce the checkpoint the
    // demo will trust.
    if (flags['refresh-snapshot'] && toRun.prerequisite !== undefined) {
      await bakePrerequisiteCheckpoints(
        toRun.prerequisite,
        resolved.spa.appDir,
        { ...deps, settleBarrier: this.getSettleBarrier(profile.slot, (l) => this.log(l)) },
        { git: this.getGitRunner(), log: (l) => this.log(l), fail: (msg: string): never => this.error(msg) },
      );
    }

    // ── 3. bring-up window: prerequisite (checkpoint restore else replay,
    // owning reset+seed) + up/verify of the demo closure, WITHOUT spawning the
    // demo spec — `stages: []` is the Plan-13 empty window (the same pattern as
    // connect's bootstrap prerequisite step). Splitting the run here is what
    // lets the admin browser open BEFORE the held foreground spawn owns the TTY. ──
    try {
      const upCode = await executeResolvedFlow(
        { ...toRun, stages: [] },
        deps,
        { lane: 'stack', skipReset: flags.reuse, passthrough: [], prereqFromSnapshot: flags['prereq-from-snapshot'] },
      );
      if (upCode !== 0) this.exit(upCode);
    } catch (err) {
      if (err instanceof FlowExecError) this.error(err.message);
      throw err;
    }

    // ── 4. the admin hand-off — jar + vendored browser at the SESSION-mode
    // attendance dash, deliberately UN-awaited: the headful browser never exits
    // until its window closes, and the held demo below needs the TTY. Fired
    // BEFORE the joins so the presenter watches the counters climb from zero
    // (the spec's DEMO_HOLD pre-join pause is this window). Best-effort
    // throughout: a failed mint / headless host WARNS, never blocks the demo.
    // The AbortController owns the child's LIFECYCLE: every exit path below
    // either awaits the window or aborts it — the child is never orphaned. ──
    const dashPort = runtime.launchContext.ports['saga-dash'];
    const adminEmail = process.env.ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL;
    const adminUrl = dashPort !== undefined ? `http://localhost:${dashPort}${ADMIN_DASH_PATH}` : undefined;
    // The printed `ss stack login` remediations must CARRY the slot/state-dir
    // pins: `stack login` is slot-aware but defaults to slot 0, so a bare paste
    // at --slot N would mint against slot 0's iam while LOGIN_DASH_URL points at
    // slot N's dash — an unauthenticated browser against the wrong iam.
    const loginPins =
      (flags.slot > 0 ? ` --slot ${flags.slot}` : '') +
      (flags['state-dir'] !== undefined ? ` --state-dir ${flags['state-dir']}` : '');
    const loginOneLiner = (url: string): string =>
      `LOGIN_DASH_URL="${url}" ss stack login ${adminEmail} --browser${loginPins}`;
    const browserAbort = new AbortController();
    let browserDone: Promise<void> | undefined;
    if (flags.admin) {
      const res = await this.mintNativeLoginJar({ email: adminEmail, slot: profile.slot, stateDir });
      if (!res.ok) {
        this.warn(
          `admin hand-off: session mint failed (HTTP ${res.status}) for ${adminEmail} — the stack is up but no ` +
            'admin browser opens. Confirm the seed materialized the persona, or log in manually: ' +
            loginOneLiner(adminUrl ?? ADMIN_DASH_PATH),
        );
      } else if (adminUrl === undefined) {
        this.warn('admin hand-off: no saga-dash port resolved — browser open skipped.');
      } else {
        this.log(`==> opening the admin dash as ${adminEmail} at ${adminUrl} (best-effort; a headless host warns)…`);
        this.log('    pick "E2E Journey Program" — the pre-join hold gives you ~20s before the students join.');
        // openVendoredBrowser never rejects (spawn failures warn internally; an
        // ABORT-triggered rejection is swallowed as the requested close), so the
        // un-awaited promise is safe; it resolves when the window closes.
        browserDone = this.openVendoredBrowser(flags, {
          email: adminEmail,
          iamUrl: res.iamUrl,
          stateDir,
          dashUrl: adminUrl,
          signal: browserAbort.signal,
        });
      }
    } else if (adminUrl !== undefined) {
      // Script parity: --no-admin prints the manual login one-liner.
      this.log(`--no-admin: log in yourself with  ${loginOneLiner(adminUrl)}`);
    }
    // Failure-path twin of the success-path hold below: the shell-script spec
    // KILLS the admin browser in its cleanup trap — exiting with the vendored
    // Chromium still writing to the freed TTY (and presenting a dead zero-dosage
    // dash) would orphan it.
    const closeAdminBrowser = async (): Promise<void> => {
      if (browserDone === undefined) return;
      browserAbort.abort();
      await browserDone;
    };

    // ── 5. the held demo run — headed foreground, stdio inherited; the hold IS
    // the spec's DEMO_HOLD pause (pre-join, then the Inspector after `[DEMO]
    // Dosage landed`). Prerequisite stripped (the window above owns it),
    // skipReset (already reset+seeded there). ──
    this.log('==> demo: tutor + 3 staggered students (ann.lee / cara.diaz / gina.park) — close a student window to freeze its counter; Resume (▶) in the Inspector ends the run.');
    try {
      const code = await executeResolvedFlow(
        { ...toRun, prerequisite: undefined },
        deps,
        { lane: 'stack', skipReset: true, passthrough },
      );
      if (code !== 0) {
        // M2 guardrail: the spec HARD-asserts pod-A membership (ann/cara/gina in
        // Alex's pod), so roster drift fails loud — surface the remedy.
        this.warn(
          'demo flow failed. If the failure is the pod-A membership guard (ann.lee/cara.diaz/gina.park not in ' +
            "Alex's pod), the seeded roster has drifted — rebake the journey prerequisite: ss develop session-adm --refresh-snapshot",
        );
        await closeAdminBrowser();
        this.exit(code);
      }
    } catch (err) {
      await closeAdminBrowser();
      if (err instanceof FlowExecError) this.error(err.message);
      throw err;
    }

    this.log('✓ demo complete — the stack stays up. Teardown when done: ss stack down');
    if (browserDone !== undefined) {
      if (flags.hold) {
        // Hold for the admin window (if still open) so its child is never orphaned —
        // mirrors coach's "the browser holds the terminal until closed".
        await browserDone;
      } else {
        // --no-hold is the advertised CI-ish straight-through run: never block on
        // a human closing the admin window — close it (reopen any time with the
        // login one-liner) instead of orphaning it past our exit.
        this.log(`--no-hold: closing the admin browser. Reopen with  ${loginOneLiner(adminUrl ?? ADMIN_DASH_PATH)}`);
        await closeAdminBrowser();
      }
    }
  }
}
