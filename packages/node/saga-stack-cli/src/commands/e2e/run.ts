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
import { DEFAULT_LOGIN_USER } from '../../core/login.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { manifest as serviceManifest } from '../../core/manifest/index.js';
import type { Lane } from '../../core/manifest/index.js';
import type { ScriptPlan } from '../../core/flag-map.js';
import { reviewBlockLines, runIdFrom } from '../../core/e2e-review.js';
import type { PreservedRunRecord } from '../../core/e2e-review.js';
import { preserveSpawnArtifacts, resolveVendorScript } from '../../runtime/index.js';
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
    '<%= config.bin %> <%= command.id %> saga-dash/periods-ordering --capture --headless',
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
    // Plan 13: exclusive window END. No oclif `exclusive:` with --through — oclif
    // treats DEFAULTED values as provided (M14 lesson); checked manually in run().
    to: Flags.string({
      description:
        'Plan 13: run UP TO but NOT INCLUDING this phase/stage (name, number, or project) — leaves the stack at that stage\'s ENTRY state for manual testing. Progressive flows only; mutually exclusive with --through. Pair with --hold for a logged-in browser at the boundary.',
    }),
    hold: Flags.boolean({
      default: false,
      description:
        'Plan 13: after the run goes green, mint the dev-persona cookie jar and open a logged-in browser at the SPA (slot-offset URL), print a held-state summary, and exit 0 — the stack stays up. Best-effort browser (a headless host warns, never errors).',
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
    // NOTE: no oclif `exclusive`/`dependsOn` here — those treat DEFAULTED values
    // as provided (a default:false boolean would demand --from on every run);
    // the interactions are checked manually in run() like --headed/--headless.
    from: Flags.string({
      description:
        "M14: start AT this stage (id / number / project — same matching as --through) by RESTORING the predecessor stage's checkpoint instead of replaying earlier Playwright stages. Bake checkpoints first with --snapshot-stages.",
    }),
    'snapshot-stages': Flags.boolean({
      default: false,
      description:
        'M14: bake a DB checkpoint after each green stage (Playwright runs once per stage) so later runs can --from into the middle of the flow. Progressive flows only.',
    }),
    'from-stale-ok': Flags.boolean({
      default: false,
      description:
        "M14: accept a checkpoint older than the 7-day staleness cliff (its baked dates may no longer fit the calendar — you're overriding that guard). Only meaningful with --from.",
    }),
    'prereq-from-snapshot': Flags.boolean({
      default: true,
      allowNo: true,
      description:
        "M14-C: satisfy a flow's prerequisite by RESTORING its terminal-stage checkpoint (when a valid one is baked) instead of the full headless replay; silently falls back to the replay when absent/invalid. NOTE the restore flushes redis (the replay leaves it warm). --no-prereq-from-snapshot forces the replay.",
    }),
    'spa-path': Flags.string({
      description: 'explicit path to a flows.json (file or dir) — highest-priority discovery override',
    }),
    'dry-run': Flags.boolean({
      description: 'plan only: print the resolved flow + closure + seed plan + playwright argv + occurrence date; touch nothing',
      default: false,
    }),
    tunnel: Flags.boolean({
      default: false,
      description:
        'point the Playwright browser at the vms tunnel hosts (https://<label>.<moniker>.<VMS_BASE>) instead of localhost, so a REMOTE peer can drive this slot-0 stack. Resolves the moniker via the vendored tunnel.sh (same machinery as `stack up --tunnel`); writes the dash tunnel config; exports PLAYWRIGHT_TUNNEL_TIMEOUT_MS for the SPA config. Slot-0 only (hard-errors at --slot > 0 / --set).',
    }),
    capture: Flags.boolean({
      default: false,
      description:
        'exploratory-review capture: run Playwright with PLAYWRIGHT_CAPTURE=all (per-action trace + video on every ' +
        'test) and PRESERVE the artifacts under <stateDir>/e2e-runs/<runId>/ (Playwright wipes test-results/ at the ' +
        "next run's start). A FAILED stage's artifacts are preserved even without this flag. Review with `e2e traces`.",
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
    if (flags.from !== undefined && flags['skip-reset']) {
      this.error('--from and --skip-reset are mutually exclusive: the checkpoint restore IS the state source.');
    }
    // Plan 13: --to (stop BEFORE K) and --through (run THROUGH K) name opposite window
    // ends — reject them together. Manual check (not oclif `exclusive:`): --through's
    // alias is --phase, and oclif would treat a defaulted value as provided (M14 lesson).
    if (flags.to !== undefined && (flags.through !== undefined || flags.phase !== undefined)) {
      this.error('--to and --through are mutually exclusive: --to K stops BEFORE stage K; --through K runs THROUGH it.');
    }
    // --tunnel fronts the FIXED slot-0 browser ports (dash :8900 / connect :6210 / iam :3010)
    // via the vms rendezvous box, so it is slot-0-only — mirroring `stack up --tunnel`
    // (up.ts:209-214). The single `flags.slot > 0` check covers `--set` too (a set pins a
    // slot > 0). Checked before runSetPreflight (the set brings its slot up).
    if (flags.tunnel && flags.slot > 0) {
      this.error(
        `slot ${flags.slot}: --tunnel fronts the FIXED slot-0 browser ports (dash :8900 / connect :6210 / iam :3010) ` +
          'via the vms rendezvous box, so it cannot run against a peer slot/set. Run the e2e flow at slot 0.',
      );
    }
    // --tunnel only makes sense on the local `stack` lane: the tunnel hosts front the
    // LOCAL stack, and tunnelServiceUrlEnv is `lane === 'stack'`-gated. A deployed lane
    // (e.g. `sandbox`) resolves its own hostnames, so --tunnel would spawn tunnel.sh and
    // export the WAN timeout for nothing. Guard it rather than silently no-op.
    if (flags.tunnel && flags.lane !== 'stack') {
      this.error(
        `--tunnel targets the local stack lane (its hosts front YOUR stack), but --lane ${flags.lane} ` +
          'resolves its own URLs. Drop --tunnel, or drop --lane to use the stack lane.',
      );
    }

    // M13-B: the implicit set preflight (no-op without --set) — e2e run brings
    // the stack up itself, so it guards the same way `stack up --set` does.
    // Skipped on --dry-run (plan only, touches nothing).
    if (!flags['dry-run']) await this.runSetPreflight(flags);

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
      toPhase: flags.to,
      fromPhase: flags.from,
      lane,
      headed,
    });

    // Plan 13: an EMPTY window from --from K --to K restores the checkpoint but runs
    // no stage — pointless without --hold (nothing observes the restored state). Warn.
    if (resolved.stages.length === 0 && resolved.checkpoint && !flags.hold && !flags['dry-run']) {
      this.warn(
        'empty window (--from == --to): the checkpoint is restored but no stage runs and no browser is held. ' +
          'Add --hold to open a logged-in browser at the boundary, or widen the window.',
      );
    }

    const appCwd = resolveAppCwd(resolved.spa, flags, process.env);
    const now = new Date(); // the ONLY wall-clock read — fed into the pure clamp.

    // M7: resolve the slot profile once — it drives the offset ports/project/
    // container-env threading (buildStackContext), the Playwright service-URL offset,
    // and the excluded-service filter. At slot 0 it is the byte-identical no-offset
    // default (offset 0, project soa, base ports, empty container env, no exclusions).
    const profile = deriveInstance({ slot: flags.slot });
    const excluded = new Set(profile.excludedServices);

    // --tunnel: resolve <moniker>.<VMS_BASE> from the VENDORED tunnel.sh (the SAME
    // machinery as `stack up --tunnel`, up.ts:297-303) so the Playwright browser
    // hairpins to the tunnel hosts. Slot-0-only (guarded above). Resolved for BOTH
    // the dry-run (so it prints the https:// URLs) and the real run; the seam lets
    // unit tests inject a fixed moniker instead of spawning tunnel.sh.
    let tunnelDomain: string | undefined;
    if (flags.tunnel) {
      const vmsBase = process.env.VMS_BASE ?? 'vms.wootdev.com';
      const moniker = await this.getTunnelMoniker()(resolveVendorScript('tunnel.sh'));
      tunnelDomain = `${moniker}.${vmsBase}`;
    }

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
        snapshotStages: flags['snapshot-stages'],
        prereqFromSnapshot: flags['prereq-from-snapshot'],
        to: flags.to,
        hold: flags.hold,
        capture: flags.capture,
        tunnelDomain,
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
      prepWriteStamp: this.getPrepStampWriter(),
      prepRepairDeps: this.getPrepDepRepairer(),
      prepDbGenerateScan: this.getDbGenerateScan(),
      repoDirExists: this.getRepoDirCheck(),
    };
    const delegate = (plan: ScriptPlan): Promise<number> =>
      this.runScript(plan, flags as WorkspaceFlags, { propagateExit: false });
    const { runtime } = buildStackContext(flags, seams, delegate, profile, tunnelDomain);
    const api = makeStackApi(serviceManifest, runtime);

    // M14: the checkpoint store (bake/--from) — constructed AFTER applyInstanceEnv
    // (above) so it targets the slot's snapshot root + containers, with the SHARED
    // ScriptContext so the schema-ahead guard honors --set-pinned repo paths.
    const checkpointsActive =
      flags['snapshot-stages'] ||
      resolved.checkpoint !== undefined ||
      (resolved.prerequisite !== undefined && flags['prereq-from-snapshot']);
    const checkpoints = checkpointsActive
      ? this.getCheckpointStore(this.scriptContextFromFlags(flags))
      : undefined;

    // M14 §2.3 (advisory, WARN-only): the SPA checkout's HEAD — stamped into
    // bakes, drift-compared on restores. '' sha (not a git checkout) ⇒ omitted.
    let spaHead: { sha: string; dirty: boolean } | undefined;
    if (checkpointsActive) {
      const spaRepoRoot = appCwd.slice(0, appCwd.length - resolved.spa.appDir.length - 1);
      const git = this.getGitRunner();
      const sha = await git.headSha(spaRepoRoot);
      if (sha !== '') spaHead = { sha, dirty: (await git.statusPorcelain(spaRepoRoot)).trim() !== '' };
    }

    // Exploratory-review preservation (docs/e2e-review.md): copy each spawn's
    // artifacts out of the SPA's test-results/ (which Playwright wipes at the
    // next run's start) into <stateDir>/e2e-runs/<runId>/…. Fires on every
    // spawn of a --capture run and on any RED spawn regardless; the review
    // block below prints the paste-ready show-trace lines.
    const runsRoot = `${stateDir}/e2e-runs`;
    const runId = runIdFrom(now);
    const preserved: PreservedRunRecord[] = [];
    const preserveTraces = (frame: {
      appCwd: string;
      spaId: string;
      flowName: string;
      stages: readonly { id: string; project: string }[];
    }): void => {
      const record = preserveSpawnArtifacts(frame, { runsRoot, runId, warn: (l) => this.warn(l) });
      if (record.groups.length > 0) preserved.push(record);
    };
    const printReviewBlock = (): void => {
      for (const record of preserved) {
        for (const line of reviewBlockLines(record, appCwd)) this.log(line);
      }
    };

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
          checkpoints,
          preserveTraces,
          tunnelDomain,
        },
        {
          lane,
          skipReset: flags['skip-reset'],
          passthrough,
          snapshotStages: flags['snapshot-stages'],
          fromStaleOk: flags['from-stale-ok'],
          spaHead,
          prereqFromSnapshot: flags['prereq-from-snapshot'],
          capture: flags.capture,
        },
      );
      printReviewBlock();
      if (code !== 0) this.exit(code);

      // Plan 13 --hold: the window is green and the stack stays up — hand off a
      // live, logged-in browser at the boundary for manual testing. Mint the
      // dev-persona jar (M11 seam, slot-aware) + best-effort open the SPA at its
      // slot-offset URL, print a held-state summary, exit 0. NOTHING holds the TTY.
      if (flags.hold) {
        await this.holdEpilogue(resolved, flags, {
          slot: profile.slot,
          stateDir,
          spaPort: runtime.launchContext.ports[resolved.spa.system],
          services: resolved.closure.services.filter((id) => !excluded.has(id)),
          boundary: flags.to ?? flags.through ?? flags.phase,
        });
      }
    } catch (err) {
      // A red PREREQUISITE surfaces as FlowExecError after its spawn's
      // artifacts were already preserved — print the review block so the
      // reviewer gets the failure traces before the error exits.
      printReviewBlock();
      if (err instanceof FlowExecError) this.error(err.message);
      throw err;
    }
  }

  /**
   * Plan 13 --hold epilogue: mint the dev-persona cookie jar (M11 `mintNativeLoginJar`,
   * already slot-aware) and best-effort open the vendored browser at the SPA's RESOLVED
   * slot-offset URL, then print a held-state summary and return (exit 0). No process
   * holds the TTY — the stack stays up after every run and the browser is detached.
   * The browser open is best-effort: a browserless/headless host warns, never errors
   * (the jar is already minted). Mirrors `stack login --browser`'s best-effort posture.
   */
  private async holdEpilogue(
    resolved: ReturnType<typeof resolveFlow>,
    flags: WorkspaceFlags & { set?: string; to?: string; porcelain: boolean; 'output-json': boolean },
    ctx: { slot: number; stateDir: string; spaPort?: number; services: string[]; boundary?: string },
  ): Promise<void> {
    const email = DEFAULT_LOGIN_USER;
    const res = await this.mintNativeLoginJar({ email, slot: ctx.slot, stateDir: ctx.stateDir });
    if (!res.ok) {
      // A failed jar (no roster seed yet, iam down) is a WARN, not a crash — the run
      // itself passed. Skip the browser (parity with login_user: browser after devLogin).
      this.warn(
        `--hold: session mint failed (HTTP ${res.status}) — the run passed but no logged-in jar was written. ` +
          'A dev jar needs a rostered persona; run a window that seeds the roster (e.g. --to program).',
      );
      return;
    }

    const spaUrl = ctx.spaPort !== undefined ? `http://localhost:${ctx.spaPort}` : undefined;

    // The boundary label: --to K holds at K's ENTRY; otherwise we held after the run.
    const heldAt = flags.to
      ? `entry of '${flags.to}'`
      : ctx.boundary
        ? `after '${ctx.boundary}'`
        : 'the full flow';
    const setNote = flags.set ? ` --set ${flags.set}` : ctx.slot > 0 ? ` --slot ${ctx.slot}` : '';

    this.emit(
      flags,
      {
        held: true,
        flow: `${resolved.spa.id}/${resolved.flow.name}`,
        heldAt,
        slot: ctx.slot,
        set: flags.set ?? null,
        services: ctx.services,
        jarPath: res.jarPath,
        spaUrl: spaUrl ?? null,
        email,
      },
      [
        `✓ held for manual testing — ${resolved.spa.id}/${resolved.flow.name} at ${heldAt}`,
        `  slot ${ctx.slot}${flags.set ? ` (set ${flags.set})` : ''} · services up (${ctx.services.length}): ${ctx.services.join(', ')}`,
        `  logged-in as ${email} · cookie jar → ${res.jarPath}`,
        spaUrl
          ? `  opening a logged-in browser at ${spaUrl} (best-effort; a headless host warns)…`
          : '  (no SPA port resolved — browser open skipped)',
        `  teardown when done: ss stack down${setNote}`,
      ],
    );

    // Best-effort browser at the SPA's slot-offset URL. iamUrl from the mint is
    // slot-aware; dashUrl override points the vendored browser at the slot's dash.
    if (spaUrl) {
      await this.openVendoredBrowser(flags, {
        email,
        iamUrl: res.iamUrl,
        stateDir: ctx.stateDir,
        dashUrl: spaUrl,
      });
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
    `stages: ${d.stages.length > 0 ? d.stages.join(' -> ') : '(none — empty window)'}`,
    `closure (${d.closure.services.length}): ${d.closure.services.join(', ')}`,
    `databases: ${d.closure.databases.join(', ') || '(none)'}`,
    `mesh: ${d.closure.mesh.join(', ') || '(none)'}`,
    d.checkpoint
      ? `restore: ${d.checkpoint.fixtureId} (checkpoint after '${d.checkpoint.predecessor}'; validated at run time)`
      : d.reset
        ? 'reset+seed: yes'
        : d.seed
          ? 'seed: additive (no reset)'
          : 'reset+seed: no (reuse state)',
  ];
  if (d.bakeCheckpoints) {
    lines.push(`bake (per green stage): ${d.bakeCheckpoints.join(', ')}`);
  }
  if (d.seed) {
    lines.push(
      `  seed offline: ${d.seed.offline.join(', ') || '(none)'}`,
      `  seed online:  ${d.seed.online.join(', ') || '(none)'}`,
      `  seed skipped: ${d.seed.skipped.map((s) => `${s.id} (${s.reason})`).join(', ') || '(none)'}`,
    );
  }
  if (d.prerequisite) {
    lines.push(
      `prerequisite: ${d.prerequisite.spa}/${d.prerequisite.flow} (through ${d.prerequisite.stages.at(-1)}, headless)` +
        (d.prereqCheckpoint
          ? ` — restore ${d.prereqCheckpoint.fixtureId} if baked (validated at run time; else full replay)`
          : ''),
    );
  }
  if (d.to) {
    lines.push(`to (exclusive): stop BEFORE '${d.to}' — leave the stack at its entry state`);
  }
  if (d.hold) {
    lines.push('hold: after green, mint the dev cookie jar + open a logged-in browser (the stack stays up)');
  }
  if (d.env.PLAYWRIGHT_CAPTURE === 'all') {
    lines.push('capture: PLAYWRIGHT_CAPTURE=all (per-action trace + video; artifacts preserved under <stateDir>/e2e-runs)');
  }
  lines.push(
    `PLAYWRIGHT_OCCURRENCE_DATE: ${d.occurrenceDate}`,
    `playwright cwd: ${d.playwright.cwd}`,
    `playwright: ${d.playwright.argv.length > 0 ? `pnpm ${d.playwright.argv.join(' ')}` : '(none — empty window, no Playwright)'}`,
  );
  return lines;
}
