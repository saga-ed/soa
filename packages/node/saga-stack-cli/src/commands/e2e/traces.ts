/**
 * `saga-stack e2e traces` — list PRESERVED e2e run artifacts (exploratory
 * review v1, docs/e2e-review.md).
 *
 * `e2e run --capture` (and any failed stage) copies each Playwright spawn's
 * artifacts out of the SPA's `test-results/` — which Playwright wipes at the
 * next run's start — into `<stateDir>/e2e-runs/<runId>/<spa>/<flow>/<stage>/`.
 * This command lists those preserved runs NEWEST-FIRST with a paste-ready
 * `show-trace` line per trace, and `--open` launches the trace viewer on the
 * newest one (best-effort: a headless host warns, never errors — the listing
 * already printed).
 *
 *   node bin/dev.js e2e traces
 *   node bin/dev.js e2e traces --flow saga-dash/periods-ordering
 *   node bin/dev.js e2e traces --open
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { newestReport, newestTrace, tracesListingLines } from '../../core/e2e-review.js';
import { lookupSpa, parseFlowRef } from '../../core/flow/index.js';
import { listPreservedRuns } from '../../runtime/index.js';
import { resolveAppCwd } from '../../e2e-orchestrate.js';

export default class E2eTraces extends BaseCommand {
  static description =
    'List preserved e2e run traces (from `e2e run --capture` / failed stages), newest first, with paste-ready show-trace commands.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --flow saga-dash/periods-ordering',
    '<%= config.bin %> <%= command.id %> --open',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    flow: Flags.string({
      description: "filter to one flow ('<spa>/<flow>' or a bare '<flow>' across SPAs)",
    }),
    open: Flags.boolean({
      default: false,
      description:
        'open the newest preserved run: PREFERS the whole-run HTML report (`playwright show-report`) when one ' +
        'exists, else falls back to the newest trace (`show-trace`). Best-effort; a headless host warns.',
    }),
  };

  /** Preserved runs are per-slot state (`<stateDir>/e2e-runs`), so honour --slot/--set. */
  protected slotAware(): boolean {
    return true;
  }

  protected setAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(E2eTraces);

    const profile = deriveInstance({ slot: flags.slot });
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const runsRoot = `${stateDir}/e2e-runs`;

    let runs = listPreservedRuns(runsRoot);
    if (flags.flow !== undefined) {
      const ref = parseFlowRef(flags.flow);
      runs = runs.filter(
        (r) => r.flowName === ref.flowName && (ref.spaId === undefined || r.spaId === ref.spaId),
      );
    }

    // The `cd` prefix per spa: show-trace must run where Playwright is
    // installed (the SPA's app dir). An unknown spa id (foreign tree) prints
    // the bare path instead — memoized so we warn once per spa at most.
    const appCwds = new Map<string, string | null>();
    const appCwdOf = (spaId: string): string | null => {
      const hit = appCwds.get(spaId);
      if (hit !== undefined) return hit;
      const spa = lookupSpa(spaId);
      const cwd = spa ? resolveAppCwd(spa, flags, process.env) : null;
      appCwds.set(spaId, cwd);
      return cwd;
    };

    this.emit(
      flags,
      {
        runsRoot,
        runs: runs.map((r) => ({
          runId: r.runId,
          spa: r.spaId,
          flow: r.flowName,
          reports: r.reports,
          stages: r.stages.map((s) => ({ stage: s.stageId, traces: s.traces })),
        })),
      },
      [`# preserved e2e runs — ${runsRoot}`, ...tracesListingLines(runs, appCwdOf)],
    );

    if (flags.open) {
      // PREFER the whole-run HTML report (one browsable page: all scenarios,
      // named steps, embedded trace links); fall back to the newest trace.
      const report = newestReport(runs);
      const target = report
        ? { spaId: report.spaId, path: report.report, subcommand: 'show-report' }
        : ((): { spaId: string; path: string; subcommand: string } | null => {
            const t = newestTrace(runs);
            return t ? { spaId: t.spaId, path: t.trace, subcommand: 'show-trace' } : null;
          })();
      if (target === null) {
        this.warn('--open: no preserved report or trace to open.');
        return;
      }
      const cwd = appCwdOf(target.spaId);
      if (cwd === null) {
        this.warn(`--open: cannot resolve a playwright install for spa '${target.spaId}' — open it manually.`);
        return;
      }
      this.log(`opening ${target.path} via ${target.subcommand} (close the viewer to return)…`);
      const { code } = await this.getRunner().run({
        cwd,
        command: 'pnpm',
        args: ['exec', 'playwright', target.subcommand, target.path],
        env: {},
        stdio: 'inherit',
      });
      if (code !== 0) {
        this.warn(
          `--open: ${target.subcommand} exited ${code} (headless host? open it on a machine with a display).`,
        );
      }
    }
  }
}
