/**
 * `saga-stack e2e connect` — open a LIVE interactive Connect tutoring session (M5).
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
 *   node bin/dev.js e2e connect
 *   node bin/dev.js e2e connect --reuse -- --debug
 *   node bin/dev.js e2e connect --fake-media
 *   node bin/dev.js e2e connect --refresh-snapshot
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { resolveFlow } from '../../core/flow/index.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
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

/** The connect-session flow is a built-in saga-dash flow. */
const CONNECT_SPA = 'saga-dash';
const CONNECT_FLOW = 'connect-session';

export default class E2eConnect extends BaseCommand {
  static description =
    'Open a live interactive Connect session: 1 tutor + 2 students (in-process; builds the journey prerequisite, then a headed Connect room).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --reuse -- --debug',
    '<%= config.bin %> <%= command.id %> --fake-media',
    '<%= config.bin %> <%= command.id %> --refresh-snapshot',
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
        'point the headed Connect room at the vms tunnel hosts (https://<label>.<moniker>.<VMS_BASE>) instead of localhost, so a REMOTE peer can drive the session. Resolves the moniker via the vendored tunnel.sh (same machinery as `stack up --tunnel`) and writes the dash tunnel config. Connect is slot-0 only, so no slot guard is needed.',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(E2eConnect);
    const passthrough = (argv as string[]).filter((a) => a !== CONNECT_FLOW);

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
    const base = flags.reuse ? { ...resolved, prerequisite: undefined } : resolved;
    // --fake-media pins FAKE_MEDIA=1 into THIS flow's env (merged last by
    // computeEnv), so it reaches only the connect-session stage (headed
    // interactive-connect) — not the journey prerequisite, a separate ResolvedFlow.
    const toRun = flags['fake-media']
      ? { ...base, flow: { ...base.flow, env: { ...base.flow.env, FAKE_MEDIA: '1' } } }
      : base;

    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
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

    // --tunnel: resolve <moniker>.<VMS_BASE> from the VENDORED tunnel.sh (the SAME
    // machinery as `stack up --tunnel`, up.ts:297-303) so the headed Connect room
    // drives the tunnel hosts. E2eConnect is neither slot- nor set-aware ⇒ slot-0
    // only, so no slot guard is needed. The seam lets unit tests inject a fixed
    // moniker instead of spawning tunnel.sh.
    let tunnelDomain: string | undefined;
    if (flags.tunnel) {
      const vmsBase = process.env.VMS_BASE ?? 'vms.wootdev.com';
      const moniker = await this.getTunnelMoniker()(resolveVendorScript('tunnel.sh'));
      tunnelDomain = `${moniker}.${vmsBase}`;
    }

    const { runtime } = buildStackContext(flags, seams, delegate, undefined, tunnelDomain);
    const api = makeStackApi(serviceManifest, runtime);

    // M14-C: the checkpoint store so the journey prerequisite can be RESTORED
    // instead of replayed (slot-0 command — no instance env needed; --reuse
    // strips the prerequisite entirely, so nothing to restore there). Also
    // needed for --refresh-snapshot's fresh bake of the same prerequisite.
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
          { api, runner: seams.runner, appCwd, now, log: (l) => this.log(l), checkpoints },
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
        { api, runner: seams.runner, appCwd, now, log: (l) => this.log(l), checkpoints, tunnelDomain },
        {
          lane: 'stack',
          skipReset: flags.reuse,
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
}
