/**
 * `saga-stack stack up` — bring the synthetic dev stack up.
 *
 * THREE PATHS (the M4 split):
 *  - `--dry-run` (M0): resolve the dependency closure (`computeClosure`) and
 *    `emit()` it (services in launch order, databases, mesh, why each service is
 *    present). With `--only` it also prints the resolved native LAUNCH plan + the
 *    composed SEED plan. No docker / pnpm / health IO.
 *  - NATIVE partial-stack (M4): `--only <svc,…>` WITHOUT --dry-run. The comma-list
 *    is now ALLOWED. computeClosure → drive the in-process `StackApi.up(closure)`
 *    (native mesh + topo-wave service launch, NOT up.sh) → composeSeedPlan over
 *    the active closure → `StackApi.seed(plan)`. `--reset`/`--login` delegate to
 *    up.sh through the facade (their native ports are M6+). This is M4's headline.
 *  - WRAPPED full-stack (M1): NO `--only` (or `--only` + a flag the native path
 *    can't yet honour — sandbox/tunnel/workspace/record/pull/prep, which fall back
 *    to up.sh for a SINGLE service). A THIN WRAPPER: flags → `flagMap.up()` → the
 *    exact up.sh argv/env, shelled out with stdio inherited. UNCHANGED from M1.
 *
 *   node bin/dev.js stack up --only scheduling-api,sessions-api --dry-run
 *   node bin/dev.js stack up --only scheduling-api,sessions-api          # native
 *   node bin/dev.js stack up --seed roster --login                       # wrapped
 *
 * Imports come straight from the specific core modules (not the `core/index`
 * barrel) so this command stays decoupled from the seed/flow sub-barrels.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { computeClosure } from '../../core/closure.js';
import * as flagMap from '../../core/flag-map.js';
import type { RecordMode } from '../../core/flag-map.js';
import { defaultLaunchContext } from '../../core/launch-plan.js';
import { manifest } from '../../core/manifest/index.js';
import type { RepoKey, ServiceId } from '../../core/manifest/index.js';
import { composeSeedPlan } from '../../core/seed/compose-seed-plan.js';
import type { SeedAddOn, SeedPlan, SeedProfile, SeedSelection } from '../../core/seed/types.js';
import { makeStackApi } from '../../stack-api.js';
import type { Runtime, StackApi } from '../../stack-api.js';
import {
  REPO_DEFAULT_DIR,
  REPO_ENV_VAR,
  resolveRepoRoot,
  scriptCwd,
} from '../../runtime/index.js';
import type { ScriptContext } from '../../runtime/index.js';

export default class StackUp extends BaseCommand {
  static description =
    'Bring the synthetic dev stack up. --only boots the dependency closure NATIVELY; full-stack wraps up.sh; --dry-run prints the planner.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api --dry-run',
    '<%= config.bin %> <%= command.id %> --only scheduling-api,sessions-api',
    '<%= config.bin %> <%= command.id %> --seed roster --login',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    only: Flags.string({
      description:
        'services to bring up. With --dry-run, a comma-list whose dependency closure is printed. On a real run (M4) a comma-list boots the closure NATIVELY (not via up.sh); combine with a flag the native path cannot honour yet (sandbox/tunnel/workspace/record/pull/prep) and a SINGLE service still falls back to up.sh.',
    }),
    'with-playback': Flags.boolean({
      description: 'include the optional playback services (transcripts, insights, chat)',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'plan only: print the resolved closure (+ launch/seed plan for --only) and exit without touching docker/pnpm',
      default: false,
    }),
    // ── up.sh trailing flags (wrapped path; some also drive the native path) ──
    reset: Flags.boolean({
      description: 'truncate + re-seed the data DBs before bringing services up (up.sh --reset)',
      default: false,
    }),
    seed: Flags.string({
      description:
        'seed the named profile after launch (up.sh --seed <profile>). A value is required in the wrapper; up.sh\'s bare `--seed` default is `roster`, so pass `--seed roster` for that behavior.',
      options: ['roster', 'full'],
    }),
    pull: Flags.boolean({
      description: 'force a full ff-only sync of every sibling repo before build (up.sh --pull)',
      default: false,
    }),
    'no-auto-pull': Flags.boolean({
      description: 'opt out of the automatic auto-pull pass (up.sh env NO_AUTO_PULL=1)',
      default: false,
    }),
    'skip-prep': Flags.boolean({
      description: 'skip the install+build prep pass (up.sh env SKIP_PREP=1)',
      default: false,
    }),
    record: Flags.string({
      description:
        'record session traffic (up.sh --record <mode>). A value is required in the wrapper; up.sh\'s bare `--record` default is `crdt`, so pass `--record crdt` for that behavior.',
      options: ['crdt', 'av'],
    }),
    'with-qtf-demo': Flags.boolean({
      description: 'include the QTF demo seed/services (up.sh --with-qtf-demo)',
      default: false,
    }),
    tunnel: Flags.boolean({
      description: 'open the public tunnel for the stack (up.sh --tunnel)',
      default: false,
    }),
    login: Flags.boolean({
      description:
        'log in the default persona (dev@saga.org) after launch (up.sh --login); use `stack login <email>` to override the persona',
      default: false,
    }),
    sandbox: Flags.string({
      description: 'named sandbox to launch into (up.sh --sandbox <name>; accompanies --only)',
    }),
    workspace: Flags.string({
      description: 'workspace file to launch from (up.sh --workspace <file.json>)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackUp);

    const requested: ServiceId[] = parseOnly(flags.only);
    const isOnly = requested.length > 0;

    // ── --dry-run (M0/M4): planner only. ──
    if (flags['dry-run']) {
      this.runDryRun(flags, requested, isOnly);
      return;
    }

    // ── NATIVE partial-stack (M4): --only with flags the native path can honour. ──
    // Flags the native path does NOT yet implement (sandbox/tunnel overlays, the
    // pull/prep/record bash prep) force a fall-back to the up.sh wrapper, which
    // ONLY accepts a single service. A comma-list + such a flag is rejected.
    if (isOnly) {
      const needsUpSh =
        flags.sandbox !== undefined ||
        flags.workspace !== undefined ||
        flags.tunnel ||
        flags.record !== undefined ||
        flags.pull ||
        flags['no-auto-pull'] ||
        flags['skip-prep'];

      if (!needsUpSh) {
        await this.runNative(flags, requested);
        return;
      }

      if (flags.only?.includes(',')) {
        this.error(
          'comma-separated --only boots the closure NATIVELY, but that path does not yet support --sandbox/--tunnel/--workspace/--record/--pull/--no-auto-pull/--skip-prep. Drop the unsupported flag (native), pass a single service (up.sh fallback), or use --dry-run to preview.',
        );
      }
      // Single service + an unsupported-native flag ⇒ fall through to the up.sh
      // wrapper below (preserves the M1 --sandbox/single-service behaviour).
    }

    // ── WRAPPED full-stack (M1): thin wrapper over up.sh. UNCHANGED. ──
    await this.runWrapped(flags);
  }

  /** M0/M4 dry-run: print the closure (+ native launch/seed plan when --only). */
  private runDryRun(flags: DryRunFlags, requested: ServiceId[], isOnly: boolean): void {
    const resolvedRequest: ServiceId[] = isOnly
      ? requested
      : Object.values(manifest.services)
          .filter((s) => flags['with-playback'] || !s.optional)
          .map((s) => s.id);

    const known = new Set(Object.keys(manifest.services));
    const unknown = resolvedRequest.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.error(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
    }

    const closure = computeClosure(manifest, resolvedRequest, { withPlayback: flags['with-playback'] });

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
  private async runNative(flags: NativeFlags, requested: ServiceId[]): Promise<void> {
    const known = new Set(Object.keys(manifest.services));
    const unknown = requested.filter((s) => !known.has(s));
    if (unknown.length > 0) {
      this.error(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
    }

    const closure = computeClosure(manifest, requested, { withPlayback: flags['with-playback'] });
    const api = makeStackApi(manifest, this.buildRuntime(flags));

    // 1. native bring-up (mesh + topo-wave service launch).
    const up = await api.up(closure.services);
    if (!up.ok) {
      this.logUpFailure(up);
      this.exit(1);
      return;
    }

    // 2. (optional) reset — DELEGATED to up.sh for M4 (native partial reset is M6).
    // up.sh --reset truncates + re-seeds the running partial stack; the native seed
    // below then applies the SELECTED profile/add-ons on top (idempotent upserts).
    if (flags.reset) {
      const reset = await api.reset(closure.services);
      if (reset.code !== 0) this.exit(reset.code);
    }

    // 3. seed: compose over the ACTIVE closure (restored = empty for M4 — snapshot
    // integration can pass a fully-restored set later) and run it natively.
    const plan: SeedPlan = composeSeedPlan(
      this.seedSelection(flags),
      new Set(closure.services),
      new Set<ServiceId>(),
    );
    const seeded = await api.seed(plan);

    // 4. (optional) login — DELEGATED to up.sh for M4.
    if (flags.login) await api.login();

    // Report.
    const launchedIds = up.launched.map((r) => `${r.id}${r.alreadyUp ? ' (already up)' : ''}`);
    this.emit(
      flags,
      {
        native: true,
        services: closure.services,
        launched: up.launched.map((r) => ({ id: r.id, ok: r.ok, alreadyUp: r.alreadyUp ?? false, pid: r.pid ?? null })),
        mesh: { ok: up.mesh.ok, units: up.mesh.units.map((u) => ({ id: u.id, ok: u.ok })) },
        dash: up.dash?.action ?? null,
        seed: {
          ok: seeded.ok,
          offline: seeded.ran.offline,
          online: seeded.ran.online,
          skipped: seeded.skipped.map((s) => ({ id: s.id, reason: s.reason })),
          ...(seeded.failed ? { failed: seeded.failed } : {}),
        },
      },
      [
        `native partial-stack up: ${closure.services.length} service(s) launched`,
        `launched: ${launchedIds.join(', ')}`,
        `mesh: ${up.mesh.units.map((u) => `${u.id}=${u.ok ? 'ready' : 'DOWN'}`).join(', ') || '(none)'}`,
        ...(up.dash ? [`dash defaults: ${up.dash.action}`] : []),
        `seed offline: ${seeded.ran.offline.join(', ') || '(none)'}`,
        `seed online:  ${seeded.ran.online.join(', ') || '(none)'}`,
        seeded.ok ? 'seed: OK' : `seed: FAILED at ${seeded.failed}`,
      ],
    );

    if (!seeded.ok) this.exit(1);
  }

  /** M1 wrapped path: map flags → up.sh argv/env and shell out. UNCHANGED. */
  private async runWrapped(flags: WrappedFlags): Promise<void> {
    const plan = flagMap.up({
      reset: flags.reset,
      seed: flags.seed as SeedProfile | undefined,
      pull: flags.pull,
      noAutoPull: flags['no-auto-pull'],
      skipPrep: flags['skip-prep'],
      record: flags.record as RecordMode | undefined,
      withPlayback: flags['with-playback'],
      withQtfDemo: flags['with-qtf-demo'],
      tunnel: flags.tunnel,
      login: flags.login,
      only: flags.only,
      sandbox: flags.sandbox,
      workspace: flags.workspace,
    });
    await this.runScript(plan, flags);
  }

  /** Build the seed selection from the up flags (profile + playback/qtf add-ons). */
  private seedSelection(flags: { seed?: string; 'with-playback': boolean; 'with-qtf-demo': boolean }): SeedSelection {
    const addOns: SeedAddOn[] = [];
    if (flags['with-playback']) addOns.push('playback');
    if (flags['with-qtf-demo']) addOns.push('qtf');
    // up.sh's bare `--seed` defaults to `roster`; an absent --seed on a native
    // bring-up still seeds the roster baseline (matching the daily-driver default).
    return { profile: (flags.seed as SeedProfile | undefined) ?? 'roster', addOns };
  }

  /**
   * Assemble the in-process `Runtime` from the BaseCommand seams + the resolved
   * workspace. The seams (`getLauncher`/`getMeshExec`/…) are injectable, so a test
   * spies them on the prototype to drive the whole native path with fakes.
   */
  private buildRuntime(flags: NativeFlags): Runtime {
    // Pinned repo roots from the per-repo flags (kebab key → manifest env-var key).
    const pinned: Partial<Record<RepoKey, string>> = {};
    for (const kebab of Object.keys(REPO_ENV_VAR) as (keyof typeof REPO_ENV_VAR)[]) {
      const value = (flags as unknown as Record<string, string | undefined>)[kebab];
      if (value) pinned[REPO_ENV_VAR[kebab] as RepoKey] = value;
    }
    const ctx: ScriptContext = { dev: flags.dev, repoRoots: pinned };

    // Resolve the FULL repo-root map (every manifest repo, defaulted via up.sh's
    // precedence) so the launch planner can place any closure service's cwd.
    const repoRoots = {} as Record<RepoKey, string>;
    for (const repo of Object.keys(REPO_DEFAULT_DIR) as RepoKey[]) {
      repoRoots[repo] = resolveRepoRoot(repo, ctx);
    }

    const syntheticDevDir = scriptCwd({ repo: 'SOA', relPath: 'tools/synthetic-dev/up.sh' }, ctx);
    // Mirror up.sh's `${PINO_LOGGER_LEVEL:-info}` / `${…ISEXPRESSCONTEXT:-true}`:
    // honour an ambient override, else the planner's defaults.
    const launchContext = defaultLaunchContext({
      repoRoots,
      syntheticDevDir,
      pinoLevel: process.env.PINO_LOGGER_LEVEL,
      pinoIsExpressContext: process.env.PINO_LOGGER_ISEXPRESSCONTEXT,
    });

    return {
      lane: 'stack',
      launchContext,
      soaRoot: repoRoots.SOA,
      sagaDashRoot: repoRoots.SAGA_DASH,
      launcher: this.getLauncher(flags['state-dir']),
      meshExec: this.getMeshExec(),
      portProbe: this.getPortProbe(),
      dashFs: this.getDashFs(),
      prober: this.getProber(),
      runner: this.getRunner(),
      tunnel: false, // native path drives the stack lane; --tunnel forces the up.sh wrapper.
      // reset/login delegate to up.sh through the M1 script path (resolution stays
      // in BaseCommand.runScript); read-only exit handling so a delegate failure is
      // surfaced via our own exit code, not double-propagated.
      delegate: (plan) => this.runScript(plan, flags, { propagateExit: false }),
    };
  }

  /** Print a structured failure when the native bring-up did not reach all-healthy. */
  private logUpFailure(up: Awaited<ReturnType<StackApi['up']>>): void {
    if (up.mesh.conflicts.length > 0) {
      this.log('mesh preflight FAILED — host port conflicts:');
      for (const c of up.mesh.conflicts) this.log(`  ✗ ${c.message}`);
      return;
    }
    if (!up.mesh.makeOk) {
      this.log('mesh bring-up FAILED (`make up` exited non-zero)');
      return;
    }
    const downUnits = up.mesh.units.filter((u) => !u.ok).map((u) => u.id);
    if (downUnits.length > 0) {
      this.log(`mesh units never became ready: ${downUnits.join(', ')}`);
      return;
    }
    this.log(`service launch FAILED at ${up.failedAt ?? '(unknown)'} — it never became healthy`);
  }
}

// Local flag shapes (subset of the parsed StackUp flags each path reads).
type DryRunFlags = WorkspaceFlags & {
  porcelain: boolean;
  'output-json': boolean;
  'with-playback': boolean;
  seed?: string;
  'with-qtf-demo': boolean;
};
type NativeFlags = DryRunFlags & {
  'state-dir': string;
  reset: boolean;
  login: boolean;
};
type WrappedFlags = WorkspaceFlags & {
  reset: boolean;
  seed?: string;
  pull: boolean;
  'no-auto-pull': boolean;
  'skip-prep': boolean;
  record?: string;
  'with-playback': boolean;
  'with-qtf-demo': boolean;
  tunnel: boolean;
  login: boolean;
  only?: string;
  sandbox?: string;
  workspace?: string;
};

/** Split a `--only` comma list into trimmed, non-empty service ids. */
function parseOnly(only: string | undefined): ServiceId[] {
  if (!only) return [];
  return only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ServiceId[];
}
