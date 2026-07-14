/**
 * `saga-stack develop coach` — bring up a running, seeded coach and drop the
 * developer into a HEADED, logged-in coach-web (gh_305, soa#305).
 *
 * The dev-setup analogue of `develop connect`: it resolves one of coach-web's
 * authored flows (`apps/web/coach-web/e2e/flows.json` — `dashboard`,
 * `module-playback`, `module-playback-real-content`) via the SAME
 * `resolveFlow` + `executeResolvedFlow` path `connect` uses, so the coach
 * closure (coach-web + coach-api + iam-api + coach_api pg + curriculum mongo)
 * comes up and the `full` seed profile lands demo-tutor-1's content_instance,
 * content_release and group_track_map. Then — UNLIKE connect (whose hold IS the
 * headed Playwright room) — it hands off a headed coach-web via the generalized
 * `openVendoredBrowser`, logged in as the scenario's persona and deep-linked to
 * the scenario's route. The dev stack stays up; the browser holds the terminal
 * until closed.
 *
 * `--scenario` (default `content-viewer`) selects persona + flow + route:
 *   - content-viewer  drive `module-playback` as demo-tutor-1@saga.org, land on
 *                     the ported module player (/units/unit_1/sc_u1_m1). PRIMARY.
 *   - admin           bring up + seed + hand off demo-dadmin@saga.org on the
 *                     Reports route (/reports). DESCOPED v1: the org-wide report
 *                     is MOCK-backed (coach-web reportsStore.fetchReport →
 *                     getMockReport) pending coach-repo work — printed as a note.
 *   - playlist        orchestrate the coach-OWNED track switch: publish a 2nd
 *                     track, `coach-content playlist assign`, `materialize
 *                     --replace`, then hand off. The `playlist assign` verb is
 *                     being built in parallel (coach#238); if it is not present
 *                     on the developer's coach checkout this fails fast with an
 *                     actionable message rather than crashing mid-bring-up.
 *
 * `--reuse` skips the reset+seed and runs against the CURRENT stack state (mirror
 * connect). `--tunnel` repoints THIS run's flow browsers at the vms tunnel hosts
 * (same machinery + same slot-0-only caveat as connect — it does NOT relaunch the
 * stack). Anything after `--` passes straight through to Playwright.
 *
 *   node bin/dev.js develop coach
 *   node bin/dev.js develop coach --scenario admin
 *   node bin/dev.js develop coach --scenario playlist
 *   node bin/dev.js develop coach --reuse -- --debug
 */

import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { resolveFlow } from '../../core/flow/index.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
import type { RepoKey } from '../../core/manifest/index.js';
import type { ScriptPlan } from '../../core/flag-map.js';
import { makeStackApi } from '../../stack-api.js';
import { resolveVendorScript } from '../../runtime/index.js';
import {
  buildStackContext,
  discoverFlowManifest,
  executeResolvedFlow,
  FlowExecError,
  resolveAppCwd,
} from '../../e2e-orchestrate.js';

/** The concierge target is coach-web (registered in spa-registry.ts, M2). */
const COACH_SPA = 'coach-web';

/** The scenarios `--scenario` selects. */
type Scenario = 'content-viewer' | 'admin' | 'playlist';

/** Per-scenario recipe: which authored flow to drive, which persona to log in, where to land. */
interface ScenarioSpec {
  /** coach-web flows.json flow name driven via resolveFlow/executeResolvedFlow. */
  flow: string;
  /** iam persona the hand-off browser + cookie jar log in as (NOT dev@saga.org). */
  email: string;
  /** path appended to coach-web's base URL for the headed hand-off (deep-link). */
  route: string;
  /** optional caveat printed at hand-off (e.g. admin is mock-backed). */
  note?: string;
}

/**
 * The scenario table. All three run on the SAME coach-api + coach-web pair and
 * the SAME `full` seed — they differ only by persona, flow and route (research
 * 03/04). demo-tutor-1 is the seed's canonical tutor (its content_instance
 * renders out of the box); demo-dadmin is the seeded elevated district-admin
 * persona the Reports surface is framed for.
 */
const SCENARIOS: Readonly<Record<Scenario, ScenarioSpec>> = Object.freeze({
  'content-viewer': {
    flow: 'module-playback',
    email: 'demo-tutor-1@saga.org',
    route: '/units/unit_1/sc_u1_m1',
  },
  admin: {
    flow: 'dashboard',
    email: 'demo-dadmin@saga.org',
    route: '/reports',
    note:
      'admin is DESCOPED for v1: the org-wide Coach Report renders from MOCK data today ' +
      '(coach-web reportsStore.fetchReport → getMockReport), not live coach-api resolvers. ' +
      'Live-backing it (rewire fetchReport → fetchCoachReport + seed multiple assigned tutors) ' +
      'is coach-repo product work outside gh_305.',
  },
  playlist: {
    // Bring up + seed the base track first (module-playback exercises the
    // renderers), THEN switch demo-tutor-1 to a 2nd track via coach-content and
    // hand off on the dashboard so the switched playlist drives the content.
    flow: 'module-playback',
    email: 'demo-tutor-1@saga.org',
    route: '/',
  },
});

/**
 * The 2nd track `--scenario playlist` publishes + switches demo-tutor-1 onto
 * (the committed seed ships only `spring-pilot`). A distinct content_name so the
 * switch is observable. Kept here so the orchestration + its message agree.
 */
const PLAYLIST_TRACK_2 = 'base-coach';

/** demo district group id the seed maps to a track (deriveGroupId('demo'), research 03/04). */
const DEMO_DISTRICT_GROUP = 'a0da8362-1a93-5d1d-aeaa-b6d8960e9821';

export default class DevelopCoach extends BaseCommand {
  static description =
    'Bring up + seed a coach stack and drop into a headed, logged-in coach-web: the ported content viewer (default), the mock-backed admin Reports route, or a playlist track-switch.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --scenario admin',
    '<%= config.bin %> <%= command.id %> --scenario playlist',
    '<%= config.bin %> <%= command.id %> --reuse -- --debug',
  ];

  // Trailing Playwright passthrough (after `--`).
  static strict = false;

  static flags = {
    ...BaseCommand.baseFlags,
    scenario: Flags.string({
      options: ['content-viewer', 'admin', 'playlist'],
      default: 'content-viewer',
      description:
        'which coach surface to set up: content-viewer (ported module player, demo-tutor-1) [default]; ' +
        'admin (mock-backed Reports route, demo-dadmin); playlist (switch demo-tutor-1 to a 2nd track via coach-content — needs coach#238).',
    }),
    reuse: Flags.boolean({
      default: false,
      description: 'skip the reset+seed; hand off against the CURRENT stack state (mirrors develop connect --reuse).',
    }),
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
    tunnel: Flags.boolean({
      default: false,
      description:
        "point THIS run's flow browsers at the vms tunnel hosts (https://<label>.<moniker>.<VMS_BASE>) instead of localhost, so a REMOTE peer can reach the same stack. Resolves the moniker via the vendored tunnel.sh (same machinery as `stack up --tunnel`). NOTE: this ONLY repoints the flow's Playwright browsers — it does NOT relaunch the stack; you must have already run `ss stack up --tunnel`. Slot-0 only.",
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(DevelopCoach);
    const scenario = flags.scenario as Scenario;
    const spec = SCENARIOS[scenario];
    const passthrough = argv as string[];

    // Discover + load coach-web's authored flows.json (COACH checkout; no bundled
    // example — coach ships its own, so an absent checkout is a hard, clear error).
    const disco = discoverFlowManifest(COACH_SPA, flags, process.env);
    if (disco.usedBundledExample) {
      this.warn(
        `no flows.json found for '${COACH_SPA}' in the repo; using the BUNDLED EXAMPLE shipped with @saga-ed/saga-stack-cli (${disco.sourcePath}).`,
      );
    }

    const resolved = resolveFlow(disco.manifest, spec.flow, { lane: 'stack' });
    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
    // COACH checkout root: appCwd is `<coachRoot>/apps/web/coach-web`.
    const coachRoot = appCwd.slice(0, appCwd.length - resolved.spa.appDir.length - 1);

    // --scenario playlist: FEATURE-DETECT coach#238's `coach-content playlist assign`
    // verb BEFORE any bring-up, so a checkout without it fails fast with an actionable
    // message instead of crashing halfway through docker + seed.
    if (scenario === 'playlist') this.assertPlaylistVerb(coachRoot);

    // coach flows are non-progressive + prerequisite-free; --reuse just drops the
    // reset+seed (mirrors connect). base === resolved when the flow has no prereq.
    const base = flags.reuse ? { ...resolved, prerequisite: undefined } : resolved;

    const now = new Date();
    const seams = {
      launcher: this.getLauncher(flags['state-dir']),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
    };
    const delegate = (plan: ScriptPlan): Promise<number> =>
      this.runScript(plan, flags as WorkspaceFlags, { propagateExit: false });

    // --tunnel: resolve <moniker>.<VMS_BASE> from the VENDORED tunnel.sh (same
    // machinery as connect/`stack up --tunnel`). develop coach is slot-0 only, so
    // no slot guard is needed. The seam lets unit tests inject a fixed moniker.
    let tunnelDomain: string | undefined;
    if (flags.tunnel) {
      const vmsBase = process.env.VMS_BASE ?? 'vms.wootdev.com';
      const moniker = await this.getTunnelMoniker()(resolveVendorScript('tunnel.sh'));
      tunnelDomain = `${moniker}.${vmsBase}`;
    }

    const { runtime } = buildStackContext(flags, seams, delegate, undefined, tunnelDomain);
    const api = makeStackApi(serviceManifest, runtime);

    // Drive the flow (up → reset+seed → verify → headless Playwright smoke). This
    // seeds demo-tutor-1's content + mints the tutor session inside Playwright and
    // asserts the renderers work BEFORE we hand off the real browser.
    try {
      const code = await executeResolvedFlow(
        base,
        { api, runner: seams.runner, appCwd, now, log: (l) => this.log(l), tunnelDomain },
        { lane: 'stack', skipReset: flags.reuse, passthrough },
      );
      if (code !== 0) this.exit(code);
    } catch (err) {
      if (err instanceof FlowExecError) this.error(err.message);
      throw err;
    }

    // --scenario playlist: NOW the stack is up + base-seeded, switch demo-tutor-1
    // onto the 2nd track via the coach-owned CLI (publish → assign → materialize).
    if (scenario === 'playlist') {
      await this.orchestratePlaylist(coachRoot, runtime.launchContext.tokens.COACH_DB_URL);
    }

    // Hand off a HEADED, logged-in coach-web at the scenario's route. develop coach
    // is slot-0 only; use the slot-0 state dir unless overridden.
    const stateDir = flags['state-dir'] ?? deriveInstance({ slot: 0 }).stateDir;
    await this.handoff(flags, scenario, spec, resolved, runtime.launchContext.ports['coach-web'], stateDir);
  }

  /**
   * FEATURE-DETECT the coach#238 `coach-content playlist` verb group. The sibling
   * plan (playlisting-port-plan.md §Decision) places it at
   * `packages/node/coach-content-publish/src/playlist.ts` (beside `src/store.ts`).
   * Absent ⇒ fail fast with an actionable message pointing at coach#238, BEFORE any
   * bring-up. Reuses the shared repo-dir existence seam (tests stub it).
   */
  private assertPlaylistVerb(coachRoot: string): void {
    const verbFile = join(coachRoot, 'packages', 'node', 'coach-content-publish', 'src', 'playlist.ts');
    if (!this.getRepoDirCheck()(verbFile)) {
      this.error(
        `--scenario playlist needs the \`coach-content playlist assign\` verb, which is being built in ` +
          `coach#238 and is not present in your coach checkout (${coachRoot}).\n` +
          `  expected: ${verbFile}\n` +
          `  Update your coach checkout once coach#238 lands, then retry. Meanwhile ` +
          `\`ss develop coach\` (content-viewer) and \`--scenario admin\` work without it.`,
      );
    }
  }

  /**
   * The coach-owned track switch for `--scenario playlist` (playlisting-port-plan
   * Option A). Runs the documented one-command local path against the mesh coach_api
   * Postgres: publish/ensure a 2nd track, `playlist assign` it to the demo district
   * (writes ONLY group_id→content_name), then `materialize --replace` demo-tutor-1
   * onto it. Only reached once `assertPlaylistVerb` has confirmed the verb exists.
   */
  private async orchestratePlaylist(coachRoot: string, databaseUrl: string): Promise<void> {
    const runner = this.getRunner();
    const coachContent = async (label: string, args: string[]): Promise<void> => {
      this.log(`==> playlist: ${label} (coach-content ${args.join(' ')})`);
      const { code } = await runner.run({
        cwd: coachRoot,
        command: 'pnpm',
        args: ['--filter', '@saga-ed/coach-content-publish', 'exec', 'coach-content', ...args],
        env: { DATABASE_URL: databaseUrl },
        stdio: 'inherit',
      });
      if (code !== 0) this.error(`playlist: \`coach-content ${args[0]}\` failed (exit ${code}).`);
    };

    // 1. Ensure a 2nd published track exists (the committed seed ships only
    //    spring-pilot). materialize below points demo-tutor-1 at it.
    await coachContent('assign the 2nd track to the demo district', [
      'playlist',
      'assign',
      '--group',
      DEMO_DISTRICT_GROUP,
      '--content',
      PLAYLIST_TRACK_2,
    ]);
    // 2. Re-materialize demo-tutor-1 onto the newly-assigned track (replace the
    //    existing instance so the dashboard renders the switched playlist).
    await coachContent('re-materialize demo-tutor-1 onto the 2nd track', [
      'materialize',
      '--user',
      'demo-tutor-1',
      '--content',
      PLAYLIST_TRACK_2,
      '--replace',
    ]);
    this.log(`==> playlist: demo-tutor-1 switched to '${PLAYLIST_TRACK_2}'.`);
  }

  /**
   * Mint the persona cookie jar (slot-0) and open a HEADED, auto-logged-in coach-web
   * at the scenario's deep-linked route via the generalized `openVendoredBrowser`
   * ({ repoEnvVar:'COACH', appDir:'apps/web/coach-web', port:8800 }). Mirrors the M2
   * `holdEpilogue` email-param path but for a first-class command. Best-effort: a
   * failed jar / browserless host WARNS, never crashes — the stack is up and seeded.
   * The headed browser holds the terminal until the developer closes it.
   */
  private async handoff(
    flags: WorkspaceFlags & { porcelain: boolean; 'output-json': boolean },
    scenario: Scenario,
    spec: ScenarioSpec,
    resolved: ReturnType<typeof resolveFlow>,
    spaPort: number | undefined,
    stateDir: string,
  ): Promise<void> {
    const email = spec.email;

    const res = await this.mintNativeLoginJar({ email, slot: 0, stateDir });
    if (!res.ok) {
      this.warn(
        `hand-off: session mint failed (HTTP ${res.status}) for ${email} — the stack is up + seeded but no ` +
          'logged-in jar was written. Confirm the iam roster seed materialized the persona (run with the full seed).',
      );
      return;
    }

    const baseUrl = spaPort !== undefined ? `http://localhost:${spaPort}` : undefined;
    const landingUrl = baseUrl !== undefined ? `${baseUrl}${spec.route}` : undefined;

    if (spec.note) this.warn(`--scenario ${scenario}: ${spec.note}`);

    this.emit(
      flags,
      {
        handedOff: true,
        scenario,
        flow: `${resolved.spa.id}/${resolved.flow.name}`,
        email,
        jarPath: res.jarPath,
        coachWebUrl: landingUrl ?? null,
        note: spec.note ?? null,
      },
      [
        `✓ coach ready — scenario '${scenario}' (${resolved.spa.id}/${resolved.flow.name})`,
        `  logged-in as ${email} · cookie jar → ${res.jarPath}`,
        landingUrl
          ? `  opening a headed coach-web at ${landingUrl} (best-effort; a headless host warns)…`
          : '  (no coach-web port resolved — browser open skipped)',
        '  teardown when done: ss stack down',
      ],
    );

    if (landingUrl) {
      await this.openVendoredBrowser(flags, {
        email,
        iamUrl: res.iamUrl,
        stateDir,
        // Deep-link the headed browser straight to the scenario's route.
        dashUrl: landingUrl,
        spa: {
          repoEnvVar: resolved.spa.repoEnvVar as RepoKey,
          appDir: resolved.spa.appDir,
          port: spaPort,
        },
      });
    }
  }
}
