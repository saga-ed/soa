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
 *   - playlist        orchestrate the coach-OWNED track switch onto the 2nd track
 *                     coach-db's seed already ships (curriculum-coach-b — no
 *                     publish step): `coach-content playlist assign` the demo
 *                     district to it, `materialize --replace` demo-tutor-1's
 *                     instance (keyed by the tutor's derived user id) onto it, then
 *                     hand off. Needs the `coach-content playlist` verb (coach#238)
 *                     AND the seeded 2nd track; a precheck confirms BOTH before any
 *                     bring-up and fails fast with an actionable message otherwise.
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
 * The 2nd track `--scenario playlist` switches demo-tutor-1 onto. It is a
 * MATERIALIZABLE curriculum coach-db's offline seed ALREADY ships in the active
 * content_release (fixtures/content-release.json → `curriculum-coach-b`: a
 * top-level-nav + units track twin of `curriculum-coach`, the only doc shape
 * `coach-content materialize` can instantiate). Distinct from the tutor's seeded
 * track (`spring-pilot`) so the switch is observable. NOT published at runtime —
 * the precheck confirms this name is present in the developer's coach seed before
 * any bring-up, so `materialize --content` always has a real target.
 */
const PLAYLIST_TRACK_2 = 'curriculum-coach-b';

/**
 * `--real-content`: coach-web's AUTHORED flow that plays REAL archive curriculum
 * instead of the synthetic seed. It publishes the archive's `base-coach` into the
 * slot's coach_api Postgres (`coach-content publish`), materializes demo-tutor-1
 * onto it, then renders the SAME route the synthetic flow uses
 * (`/units/unit_1/sc_u1_m1` — real base-coach carries that module; coach-db's
 * synthetic `curriculum-coach` release does NOT, which is why the default flow
 * shows "Couldn't Load Module" — coach#228 seed misalignment, research/11).
 * The flow's own flows.json `env` block sets `PUBLISH_REAL_CONTENT=1`; the ONLY
 * thing the invoker must supply is `ARCHIVE_DIR` (a content-archive checkout).
 */
const REAL_CONTENT_FLOW = 'module-playback-real-content';

/**
 * demo-tutor-1's canonical coach user id — `deriveUserId('demo-tutor-1')` from
 * `@saga-ed/iam-seed-ids`, the id coach-db's seed keys the tutor's persona +
 * content_instance to (content-instances.json) AND the id coach-web's iam
 * `whoami` returns. `materialize` MUST write the switched instance under THIS id,
 * not the `demo-tutor-1` HANDLE, or the new playlist is invisible to coach-web.
 * Hardcoded with an explicit derivation note (the soa CLI is a separate monorepo
 * that cannot import iam-seed-ids) — mirrors DEMO_DISTRICT_GROUP below.
 */
const COACH_TUTOR_USER_ID = '1c939568-1464-5f9a-b5a4-0bc73a0454cb';

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
    'real-content': Flags.boolean({
      default: false,
      description:
        "content-viewer only: play REAL curriculum published from a saga-ed/content-archive checkout (base-coach) instead of coach-db's synthetic acceptance fixture. Drives coach-web's authored `module-playback-real-content` flow, which publishes the archive into the slot's coach_api Postgres and materializes demo-tutor-1 onto it. Needs an archive checkout (--archive-dir / $ARCHIVE_DIR / $DEV/content-archive).",
    }),
    'archive-dir': Flags.string({
      description:
        'path to a saga-ed/content-archive checkout for --real-content (default: $ARCHIVE_DIR, else <dev>/content-archive).',
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

  /**
   * `develop coach` brings up an isolated `soa-s<N>` coach sub-stack at slot > 0
   * — the whole point of a per-slot dev concierge. It mirrors `e2e run` (same
   * slot-aware `executeResolvedFlow`), derives the slot profile via
   * `deriveInstance`, and hands off the browser at the SLOT-OFFSET coach-web port
   * (`launchContext.ports['coach-web']`), so nothing is pinned to slot 0.
   */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(DevelopCoach);
    const scenario = flags.scenario as Scenario;
    const spec = SCENARIOS[scenario];
    const passthrough = argv as string[];

    // --tunnel fronts the FIXED slot-0 browser ports via the vms rendezvous box,
    // so it is slot-0-only — mirroring `e2e run --tunnel` (run.ts) and `stack up
    // --tunnel`. The `flags.slot > 0` check covers `--set` too (a set pins slot > 0).
    if (flags.tunnel && flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: --tunnel fronts the FIXED slot-0 browser ports via the vms rendezvous box, ` +
          'so it cannot run against a peer slot/set. Run develop coach at slot 0, or drop --tunnel.',
      );
    }

    // Discover + load coach-web's authored flows.json (COACH checkout; no bundled
    // example — coach ships its own, so an absent checkout is a hard, clear error).
    const disco = discoverFlowManifest(COACH_SPA, flags, process.env);
    if (disco.usedBundledExample) {
      this.warn(
        `no flows.json found for '${COACH_SPA}' in the repo; using the BUNDLED EXAMPLE shipped with @saga-ed/saga-stack-cli (${disco.sourcePath}).`,
      );
    }

    // --real-content swaps the content-viewer's synthetic flow for coach-web's
    // authored REAL-archive flow (publish base-coach → materialize → same route).
    if (flags['real-content'] && scenario !== 'content-viewer') {
      this.error(
        `--real-content applies to --scenario content-viewer (got '${scenario}'). ` +
          'It swaps the ported module player onto REAL published archive curriculum; ' +
          'admin/playlist do not read the archive.',
      );
    }
    const flowName = flags['real-content'] ? REAL_CONTENT_FLOW : spec.flow;

    const resolved = resolveFlow(disco.manifest, flowName, { lane: 'stack' });
    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
    // COACH checkout root: appCwd is `<coachRoot>/apps/web/coach-web`.
    const coachRoot = appCwd.slice(0, appCwd.length - resolved.spa.appDir.length - 1);

    // --scenario playlist: PRECHECK coach#238's `coach-content playlist` verb AND
    // coach-db's seeded 2nd track BEFORE any bring-up, so a checkout missing either
    // fails fast with an actionable message instead of crashing halfway through
    // docker + seed (or, worse, materializing against a track that isn't there).
    if (scenario === 'playlist') this.assertPlaylistPrereqs(coachRoot);

    // --real-content: resolve + PRECHECK the content-archive checkout BEFORE any
    // bring-up, then export it as ARCHIVE_DIR — the ONE thing the authored flow
    // requires from "the invoking shell's env" (its flows.json env block supplies
    // PUBLISH_REAL_CONTENT=1; DATABASE_URL comes from our own launch-plan). The
    // Runner spawns Playwright with `{...process.env, ...spec.env}`, so setting it
    // here is exactly the contract the flow documents.
    if (flags['real-content']) {
      const archiveDir = this.resolveArchiveDir(flags);
      this.assertRealContentPrereqs(archiveDir);
      process.env.ARCHIVE_DIR = archiveDir;
      this.log(`==> real-content: publishing base-coach from ${archiveDir}`);
    }

    // coach flows are non-progressive + prerequisite-free; --reuse just drops the
    // reset+seed (mirrors connect). base === resolved when the flow has no prereq.
    const base = flags.reuse ? { ...resolved, prerequisite: undefined } : resolved;

    const now = new Date();

    // M7: resolve the slot profile once — it drives the offset ports/project/
    // container-env (buildStackContext), the launcher's per-slot state dir, and the
    // DB/mesh targeting so `--slot N` provisions + migrates + seeds against slot N's
    // OWN offset ports/DBs (mirrors e2e run.ts). At slot 0 it is the byte-identical
    // no-offset default. WITHOUT this, `--slot N` would silently target slot 0.
    const profile = deriveInstance({ slot: flags.slot });
    // Apply the slot's container-env seam (mesh container names + snapshot dir) and
    // point the launcher at the slot's state dir (pids/logs) — both no-ops at slot 0.
    this.applyInstanceEnv(profile);
    const stateDir = flags['state-dir'] ?? profile.stateDir;

    const seams = {
      launcher: this.getLauncher(stateDir),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      // soa#300: buildStackContext threads this into the runtime so StackApi.up writes
      // coach-web's `.env.local` (local mesh offset URLs) before launch — else its
      // browser inlines the checked-in `.env` remote defaults and 503s at sign-in.
      coachWebFs: this.getCoachWebFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
      // Native-prep seams: buildStackContext wires them into the runtime at EVERY
      // slot so StackApi.up runs R2 provision + R3 migrate on the slot's offset DBs
      // before launch+seed (mirrors e2e run.ts — required for a slot > 0 bring-up).
      pgProbe: this.getPgProbe(),
      prepIsFresh: this.getPrepFreshCheck(),
      prepWriteStamp: this.getPrepStampWriter(),
      prepRepairDeps: this.getPrepDepRepairer(),
      prepDbGenerateScan: this.getDbGenerateScan(),
      repoDirExists: this.getRepoDirCheck(),
    };
    const delegate = (plan: ScriptPlan): Promise<number> =>
      this.runScript(plan, flags as WorkspaceFlags, { propagateExit: false });

    // --tunnel: resolve <moniker>.<VMS_BASE> from the VENDORED tunnel.sh (same
    // machinery as connect/`stack up --tunnel`). Guarded slot-0-only above (the
    // tunnel fronts fixed slot-0 ports). The seam lets unit tests inject a moniker.
    let tunnelDomain: string | undefined;
    if (flags.tunnel) {
      const vmsBase = process.env.VMS_BASE ?? 'vms.wootdev.com';
      const moniker = await this.getTunnelMoniker()(resolveVendorScript('tunnel.sh'));
      tunnelDomain = `${moniker}.${vmsBase}`;
    }

    const { runtime } = buildStackContext(flags, seams, delegate, profile, tunnelDomain);
    const api = makeStackApi(serviceManifest, runtime);

    // --real-content: the authored flow's lane (`real-content-lane.ts`) gates on
    // ARCHIVE_DIR **and** DATABASE_URL ("the stack lane's own DB" — its flows.json
    // says saga-stack-cli supplies it), and SELF-SKIPS if either is missing. Export
    // the SLOT's coach_api URL now that the launch context is resolved, so the spec
    // publishes into THIS slot's Postgres instead of silently skipping.
    if (flags['real-content']) {
      process.env.DATABASE_URL = runtime.launchContext.tokens.COACH_DB_URL;
    }

    // Drive the flow (up → reset+seed → verify → headless Playwright smoke). This
    // seeds demo-tutor-1's content + mints the tutor session inside Playwright and
    // asserts the renderers work BEFORE we hand off the real browser.
    try {
      const code = await executeResolvedFlow(
        base,
        // Pass the SLOT-OFFSET ports (mirrors e2e run) so the coach-web Playwright
        // spawn gets PLAYWRIGHT_IAM_URL = the slot iam and PLAYWRIGHT_BASE_URL = the
        // slot coach-web. Without this the specs' lane.ts falls back to base ports
        // (iam :3010, coach-web :8800) — globalSetup then mints the iam_session on
        // the wrong iam and the browser boots 503 (soa#300 tail).
        {
          api,
          runner: seams.runner,
          appCwd,
          now,
          log: (l) => this.log(l),
          slot: profile.slot,
          ports: runtime.launchContext.ports,
          tunnelDomain,
        },
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

    // Hand off a HEADED, logged-in coach-web at the scenario's route — the slot's
    // OFFSET coach-web port + the per-slot state dir resolved above.
    await this.handoff(flags, scenario, spec, resolved, runtime.launchContext.ports['coach-web'], stateDir);
  }

  /**
   * PRECHECK both prerequisites the coach-owned playlist switch needs, BEFORE any
   * bring-up, so a stale coach checkout fails fast with an actionable message
   * instead of an opaque throw mid-orchestration:
   *
   *   1. the coach#238 `coach-content playlist` verb group — placed at
   *      `packages/node/coach-content-publish/src/playlist.ts` (beside `store.ts`),
   *      per playlisting-port-plan.md §Decision. Absent ⇒ point at coach#238.
   *   2. the seeded 2nd track (`PLAYLIST_TRACK_2`) — a MATERIALIZABLE curriculum in
   *      coach-db's offline seed release (fixtures/content-release.json). Without it
   *      `materialize --content` throws `active release has no curriculum doc named`
   *      deep in the run. We read the fixture and confirm the track is present so
   *      the materialize target the orchestration uses is guaranteed to exist.
   *
   * Reuses the shared repo-dir existence + repo-file-read seams (tests stub them).
   */
  /**
   * The content-archive checkout `--real-content` publishes from: an explicit
   * `--archive-dir`, else `$ARCHIVE_DIR` (the env var the authored flow documents),
   * else the sibling-repo convention `<dev>/content-archive` — mirroring how every
   * other repo root resolves (`runtime/scripts.ts` `resolveRepoRoot`).
   */
  private resolveArchiveDir(flags: { 'archive-dir'?: string; dev?: string }): string {
    const dev = flags.dev ?? process.env.DEV ?? join(process.env.HOME ?? '', 'dev');
    return flags['archive-dir'] ?? process.env.ARCHIVE_DIR ?? join(dev, 'content-archive');
  }

  /**
   * `--real-content` PRECHECK: the archive must be a real git checkout before we
   * spend a docker bring-up + full seed on a run the flow would only self-skip
   * (`real-content-lane.ts` returns `{skip}` when ARCHIVE_DIR is unset/blank, and
   * the spec asserts `<archiveDir>/.git` exists). Fail fast + actionable instead.
   */
  private assertRealContentPrereqs(archiveDir: string): void {
    if (!this.getRepoDirCheck()(join(archiveDir, '.git'))) {
      this.error(
        `--real-content needs a saga-ed/content-archive checkout, but ${archiveDir} is not a git checkout.\n` +
          `  clone it:  git clone git@github.com:saga-ed/content-archive.git ${archiveDir}\n` +
          `  or point at an existing one:  --archive-dir <path>  (or export ARCHIVE_DIR=<path>)\n` +
          `  Without --real-content, content-viewer plays coach-db's synthetic seed instead.`,
      );
    }
  }

  private assertPlaylistPrereqs(coachRoot: string): void {
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

    // The 2nd track must exist as a materializable curriculum in coach-db's seed
    // release — otherwise the later `materialize --content ${PLAYLIST_TRACK_2}`
    // aborts with `active release has no curriculum doc named …`.
    const seedFixture = join(
      coachRoot,
      'packages', 'node', 'coach-db', 'src', 'seed', 'fixtures', 'content-release.json',
    );
    const raw = this.getRepoFileRead()(seedFixture);
    if (raw === undefined) {
      this.error(
        `--scenario playlist could not read coach-db's seed fixture to confirm the 2nd track ` +
          `'${PLAYLIST_TRACK_2}' is present.\n` +
          `  expected: ${seedFixture}\n` +
          `  Update your coach checkout (it must ship the additive seed with '${PLAYLIST_TRACK_2}'), then retry.`,
      );
    }
    let tracks: string[];
    try {
      const parsed = JSON.parse(raw) as { curricula?: Array<{ name?: unknown }> };
      tracks = (parsed.curricula ?? []).map((c) => String(c.name));
    } catch {
      this.error(
        `--scenario playlist: coach-db's seed fixture is not valid JSON, cannot confirm the 2nd track.\n` +
          `  file: ${seedFixture}`,
      );
    }
    if (!tracks.includes(PLAYLIST_TRACK_2)) {
      this.error(
        `--scenario playlist needs the materializable 2nd track '${PLAYLIST_TRACK_2}' in coach-db's seed ` +
          `release, but your coach checkout's fixture does not ship it (found: ${tracks.join(', ') || 'none'}).\n` +
          `  file: ${seedFixture}\n` +
          `  Update your coach checkout to the additive seed that adds '${PLAYLIST_TRACK_2}', then retry.`,
      );
    }
  }

  /**
   * The coach-owned track switch for `--scenario playlist` (playlisting-port-plan
   * Option A). Runs the documented one-command local path against the mesh coach_api
   * Postgres: `playlist assign` the demo district to the seeded 2nd track (writes
   * ONLY group_id→content_name), then `materialize --replace` demo-tutor-1's
   * instance — keyed by the tutor's DERIVED user id, the id coach-web reads by —
   * onto it. No publish step: `PLAYLIST_TRACK_2` is already in coach-db's seed
   * release, and `assertPlaylistPrereqs` has confirmed both the verb and the track.
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

    // 1. Point the demo district at the seeded 2nd track (curriculum-coach-b —
    //    already in the active content_release; the precheck confirmed it).
    await coachContent('assign the 2nd track to the demo district', [
      'playlist',
      'assign',
      '--group',
      DEMO_DISTRICT_GROUP,
      '--content',
      PLAYLIST_TRACK_2,
    ]);
    // 2. Re-materialize demo-tutor-1 onto the newly-assigned track (replace the
    //    existing instance so the dashboard renders the switched playlist). Keyed
    //    by the tutor's DERIVED user id — the id coach-web's whoami returns — NOT
    //    the `demo-tutor-1` handle, or the switched instance is invisible in-app.
    await coachContent('re-materialize demo-tutor-1 onto the 2nd track', [
      'materialize',
      '--user',
      COACH_TUTOR_USER_ID,
      '--content',
      PLAYLIST_TRACK_2,
      '--replace',
    ]);
    this.log(
      `==> playlist: demo-tutor-1 (${COACH_TUTOR_USER_ID}) switched to '${PLAYLIST_TRACK_2}'.`,
    );
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
