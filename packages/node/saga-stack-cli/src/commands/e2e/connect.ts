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
 * SCOPE (plan §7.2 "M5"): the orchestration + headed run land here; AV-device /
 * post-session inspect polish is explicitly DEFERRED — the foreground hold is the
 * Playwright `page.pause()` in the spec, unchanged.
 *
 *   node bin/dev.js e2e connect
 *   node bin/dev.js e2e connect --reuse -- --debug
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { resolveFlow } from '../../core/flow/index.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
import type { ScriptPlan } from '../../core/flag-map.js';
import { makeStackApi } from '../../stack-api.js';
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
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(E2eConnect);
    const passthrough = (argv as string[]).filter((a) => a !== CONNECT_FLOW);

    const disco = discoverFlowManifest(CONNECT_SPA, flags, process.env);
    if (disco.usedBundledExample) {
      this.warn(
        `no flows.json found for '${CONNECT_SPA}' in the repo; using the BUNDLED EXAMPLE shipped with @saga-ed/saga-stack-cli (${disco.sourcePath}).`,
      );
    }

    // Foreground + headed by default (the flow is `foreground:true`); --reuse drops
    // the prerequisite + reset entirely, exactly like connect-session.sh.
    const resolved = resolveFlow(disco.manifest, CONNECT_FLOW, { lane: 'stack' });
    const toRun = flags.reuse ? { ...resolved, prerequisite: undefined } : resolved;

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
    const { runtime } = buildStackContext(flags, seams, delegate);
    const api = makeStackApi(serviceManifest, runtime);

    // M14-C: the checkpoint store so the journey prerequisite can be RESTORED
    // instead of replayed (slot-0 command — no instance env needed; --reuse
    // strips the prerequisite entirely, so nothing to restore there).
    const checkpoints =
      toRun.prerequisite !== undefined && flags['prereq-from-snapshot']
        ? this.getCheckpointStore(this.scriptContextFromFlags(flags))
        : undefined;

    try {
      const code = await executeResolvedFlow(
        toRun,
        { api, runner: seams.runner, appCwd, now, log: (l) => this.log(l), checkpoints },
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
