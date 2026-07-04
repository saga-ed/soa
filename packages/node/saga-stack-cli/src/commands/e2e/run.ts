/**
 * `saga-stack e2e run [<spa>/]<flow>` — run an e2e flow IN-PROCESS (M5).
 *
 * This is the M5 native orchestrator that REPLACES the M2 thin shell over
 * check-e2e.sh. It discovers the SPA's `flows.json` (registry repo path, or the
 * package's BUNDLED example for the built-in `saga-dash` id when the repo hasn't
 * authored one yet — and it SAYS SO), resolves the named flow to a `ResolvedFlow`
 * (dependency closure + stages + seed + prerequisite), and drives the SAME
 * six-method `StackApi` + a single Playwright spawn the bash pipeline did — but
 * via the in-process M4 facade, no up.sh, no second oclif invocation:
 *
 *   resolve flow → recurse prerequisite (headless, skip-reset) → StackApi.up(closure)
 *   → reset+seed (unless --skip-reset) → verify({tolerate:[spa.system]})
 *   → computeEnv(flow, now)  [now = new Date() AT THE COMMAND LAYER → the PURE clamp]
 *   → spawn `pnpm exec playwright test --config … --project <terminal stage>
 *      [--grep-invert @interactive] [--headed]` in the SPA's appDir via the Runner.
 *
 * `--dry-run` is the safe, testable smoke: it prints the resolved flow + closure
 * + seed plan + the Playwright argv + the injected PLAYWRIGHT_OCCURRENCE_DATE and
 * exits WITHOUT touching docker / pnpm / a single seam.
 *
 *   node bin/dev.js e2e run journey --through pods --dry-run
 *   node bin/dev.js e2e run saga-dash/journey --through 2 --headless
 *   node bin/dev.js e2e run journey --skip-reset -- --debug
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { parseFlowRef, resolveFlow } from '../../core/flow/index.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
import type { Lane } from '../../core/manifest/index.js';
import type { ScriptPlan } from '../../core/flag-map.js';
import { makeStackApi } from '../../stack-api.js';
import {
  buildStackContext,
  describeResolved,
  discoverFlowManifest,
  executeResolvedFlow,
  FlowExecError,
  resolveAppCwd,
} from '../../e2e-orchestrate.js';

/** The default SPA when the flow ref has no `<spa>/` prefix. */
const DEFAULT_SPA = 'saga-dash';

export default class E2eRun extends BaseCommand {
  static description =
    'Run an e2e flow in-process: discover flows.json -> closure -> StackApi up/reset/seed/verify -> Playwright. --dry-run prints the plan.';

  static examples = [
    '<%= config.bin %> <%= command.id %> journey --through pods --dry-run',
    '<%= config.bin %> <%= command.id %> saga-dash/journey --through 2 --headless',
    '<%= config.bin %> <%= command.id %> journey --skip-reset -- --debug',
  ];

  // One required positional ([<spa>/]<flow>) + trailing playwright passthrough (after `--`).
  static strict = false;

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    through: Flags.string({
      description: 'run THROUGH this phase/stage (name, number, or project); progressive flows run 1..N',
    }),
    phase: Flags.string({
      description: 'alias of --through',
    }),
    lane: Flags.string({
      description: 'URL lane to target',
      options: ['stack', 'sandbox'],
      default: 'stack',
    }),
    headed: Flags.boolean({
      description: 'force a headed (windowed) run (foreground flows are headed by default)',
      default: false,
    }),
    headless: Flags.boolean({
      description: 'force a headless (CI-style) run; flips a foreground flow off headed',
      default: false,
    }),
    'skip-reset': Flags.boolean({
      description: 'reuse the current stack state; skip the reset+seed before Playwright',
      default: false,
    }),
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
    'dry-run': Flags.boolean({
      description: 'plan only: print the resolved flow + closure + seed plan + playwright argv + occurrence date; touch nothing',
      default: false,
    }),
  };

  /** M7: `e2e run --slot N` brings up + drives an ISOLATED `soa-s<N>` stack. */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `e2e run --set <name>` drives the set's slot + worktree flows. */
  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(E2eRun);

    if (flags.headed && flags.headless) {
      this.error('--headed and --headless are mutually exclusive.');
    }

    // The first non-flag token is the flow ref; the rest (after `--`) are passthrough.
    const positionals = (argv as string[]).filter((a) => !a.startsWith('-'));
    const ref = positionals[0];
    if (!ref) {
      this.error('missing flow argument. Usage: e2e run [<spa>/]<flow> [--through <phase>]');
    }
    const passthrough = (argv as string[]).filter((a) => a !== ref);

    const { spaId, flowName } = parseRef(ref);
    const lane = flags.lane as Lane;

    // Discover + load the flows.json (bundled-example fallback for built-in saga-dash).
    const disco = discoverFlowManifest(spaId, flags, process.env);
    if (disco.usedBundledExample) {
      this.warn(
        `no flows.json found for '${spaId}' in the repo; using the BUNDLED EXAMPLE shipped with @saga-ed/saga-stack-cli (${disco.sourcePath}). Author ${spaId}'s own e2e/flows.json to override.`,
      );
    }

    const headed = flags.headless ? false : flags.headed ? true : undefined;
    const resolved = resolveFlow(disco.manifest, flowName, {
      throughPhase: flags.through ?? flags.phase,
      lane,
      headed,
    });

    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
    const now = new Date(); // the ONLY wall-clock read — fed into the pure clamp.

    // M7: resolve the slot profile once — it drives the offset ports/project/
    // container-env threading (buildStackContext), the Playwright service-URL offset,
    // and the excluded-service filter. At slot 0 it is the byte-identical no-offset
    // default (offset 0, project soa, base ports, empty container env, no exclusions).
    const profile = deriveInstance({ slot: flags.slot });
    const excluded = new Set(profile.excludedServices);

    // ── --dry-run: pure projection, no IO, no seam. ──
    if (flags['dry-run']) {
      const desc = describeResolved(resolved, {
        now,
        lane,
        appCwd,
        passthrough,
        skipReset: flags['skip-reset'],
        ports: profile.portOverrides,
        excluded,
      });
      this.emit(flags, { dryRun: true, ...desc } as unknown as Record<string, unknown>, dryRunLines(desc));
      return;
    }

    // ── real run: build the in-process StackApi from the BaseCommand seams. ──
    // Apply the slot's container-env seam (mesh container names + snapshot dir) and
    // point the launcher at the slot's state dir (pids/logs) — both no-ops at slot 0.
    this.applyInstanceEnv(profile);
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const seams = {
      launcher: this.getLauncher(stateDir),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
      // Native-prep seams (built always; since FLIP 3 buildStackContext wires them
      // into the runtime at EVERY slot — including slot 0 — so the native StackApi.up
      // runs R2 provision + R3 migrate before launch+seed regardless of slot).
      pgProbe: this.getPgProbe(),
      prepIsFresh: this.getPrepFreshCheck(),
      prepDbGenerateScan: this.getDbGenerateScan(),
      repoDirExists: this.getRepoDirCheck(),
    };
    const delegate = (plan: ScriptPlan): Promise<number> =>
      this.runScript(plan, flags as WorkspaceFlags, { propagateExit: false });
    const { runtime } = buildStackContext(flags, seams, delegate, profile);
    const api = makeStackApi(serviceManifest, runtime);

    try {
      const code = await executeResolvedFlow(
        resolved,
        {
          api,
          runner: seams.runner,
          appCwd,
          now,
          log: (l) => this.log(l),
          slot: profile.slot,
          ports: runtime.launchContext.ports,
          excluded,
        },
        { lane, skipReset: flags['skip-reset'], passthrough },
      );
      if (code !== 0) this.exit(code);
    } catch (err) {
      if (err instanceof FlowExecError) this.error(err.message);
      throw err;
    }
  }
}

/** Parse `[<spa>/]<flow>` applying the default SPA. */
function parseRef(ref: string): { spaId: string; flowName: string } {
  const parsed = parseFlowRef(ref);
  return { spaId: parsed.spaId ?? DEFAULT_SPA, flowName: parsed.flowName };
}

/** Human-readable dry-run lines (the JSON shape is emitted separately for --output-json). */
function dryRunLines(d: ReturnType<typeof describeResolved>): string[] {
  const lines: string[] = [
    `dry-run: ${d.spa}/${d.flow} (lane ${d.lane}${d.headed ? ', headed' : ', headless'})`,
    `stages: ${d.stages.join(' -> ')}`,
    `closure (${d.closure.services.length}): ${d.closure.services.join(', ')}`,
    `databases: ${d.closure.databases.join(', ') || '(none)'}`,
    `mesh: ${d.closure.mesh.join(', ') || '(none)'}`,
    `reset+seed: ${d.reset ? 'yes' : 'no (reuse state)'}`,
  ];
  if (d.seed) {
    lines.push(
      `  seed offline: ${d.seed.offline.join(', ') || '(none)'}`,
      `  seed online:  ${d.seed.online.join(', ') || '(none)'}`,
      `  seed skipped: ${d.seed.skipped.map((s) => `${s.id} (${s.reason})`).join(', ') || '(none)'}`,
    );
  }
  if (d.prerequisite) {
    lines.push(`prerequisite: ${d.prerequisite.spa}/${d.prerequisite.flow} (through ${d.prerequisite.stages.at(-1)}, headless)`);
  }
  lines.push(
    `PLAYWRIGHT_OCCURRENCE_DATE: ${d.occurrenceDate}`,
    `playwright cwd: ${d.playwright.cwd}`,
    `playwright: pnpm ${d.playwright.argv.join(' ')}`,
  );
  return lines;
}
