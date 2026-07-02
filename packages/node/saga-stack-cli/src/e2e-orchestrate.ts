/**
 * `e2e-orchestrate` — the M5 in-process e2e orchestration (plan §5.4 / §7.2 "M5").
 *
 * This is the glue the `e2e run` / `e2e connect` commands drive: it turns a
 * resolved `flows.json` flow into the SAME six-method `StackApi` calls + a single
 * Playwright spawn that the bash `check-e2e.sh` → `run-stack-e2e.sh` pipeline did,
 * but IN-PROCESS via the M4 facade — no second oclif invocation, no up.sh.
 *
 * It owns three responsibilities, each split so the command layer stays thin and
 * the planning stays testable:
 *  1. DISCOVERY (`discoverFlowManifest`) — locate + load a SPA's `flows.json`
 *     (overrides → registry repo path), falling back to the package's BUNDLED
 *     example for the built-in `saga-dash` id when the repo hasn't authored one
 *     yet (and reporting that it did so). The fs touch is the runtime
 *     `loadFlowsFrom` helper; everything else is pure path math from `core/flow`.
 *  2. CONTEXT (`buildStackContext`) — assemble the in-process `Runtime` for
 *     `makeStackApi` from the injected BaseCommand seams + the resolved workspace
 *     (mirrors `stack up`'s `buildRuntime`; the duplication is flagged as a TODO
 *     to extract once both call sites have soaked).
 *  3. EXECUTION (`executeResolvedFlow`) — recurse any prerequisite (headless,
 *     skip-reset on the child), `StackApi.up(closure)` → reset+seed (unless
 *     skipped) → `verify({tolerate:[spa.system]})` → `computeEnv(flow, now)` →
 *     spawn `pnpm exec playwright test --config … --project …` via the Runner.
 *     `describeResolved` is the pure dry-run/JSON projection (no IO, no seam).
 *
 * PURITY: this module lives OUTSIDE `core/**`, so it may compose the runtime IO
 * seams. The genuinely pure bits (`describeResolved`, `playwrightArgv`) take a
 * REFERENCE date / explicit inputs and never read the wall clock — the command
 * supplies the real `now` (`new Date()` at the command layer), honouring the
 * core date-purity rule the clamp depends on.
 */

import { fileURLToPath } from 'node:url';
import { composeSeedPlan } from './core/seed/compose-seed-plan.js';
import { computeEnv, ENV_OCCURRENCE_DATE } from './core/flow/env.js';
import {
  flowsCandidatePaths,
  knownSpaIds,
  lookupSpa,
  resolveRepoRoot as resolveSpaRepoRoot,
  splitSpaPaths,
} from './core/flow/index.js';
import type { ResolvedFlow, SpaDescriptor } from './core/flow/index.js';
import { defaultLaunchContext } from './core/launch-plan.js';
import { manifest as serviceManifest } from './core/manifest/index.js';
import type { Manifest, RepoKey, ServiceId } from './core/manifest/index.js';
import { healthProbes } from './core/probe-plan.js';
import type { Lane } from './core/manifest/index.js';
import type { ScriptPlan } from './core/flag-map.js';
import { makeStackApi } from './stack-api.js';
import type { Runtime, StackApi } from './stack-api.js';
import {
  loadFlowsFrom,
  REPO_DEFAULT_DIR,
  REPO_ENV_VAR,
  resolveRepoRoot,
  scriptCwd,
} from './runtime/index.js';
import type {
  DashFs,
  HealthProber,
  MeshExec,
  PortProbe,
  Runner,
  ScriptContext,
  ServiceLauncher,
} from './runtime/index.js';
import type { FlowManifest } from './core/flow/index.js';

// ── discovery ──────────────────────────────────────────────────────────────

/** The bundled example `flows.json` shipped for the built-in SPAs (the fallback template). */
const BUNDLED_EXAMPLE: Readonly<Record<string, string>> = Object.freeze({
  // Resolved relative to THIS module so it works from both `src` (tsx tests) and
  // `dist` (published): `<pkg>/examples/flows/saga-dash.flows.json`. The file is
  // shipped via package.json `files: ["examples"]`.
  'saga-dash': fileURLToPath(new URL('../examples/flows/saga-dash.flows.json', import.meta.url)),
  // connectv3 (M6): the second-SPA proof. A DATA row only — the fallback logic is
  // generic over this map, so onboarding connectv3 added a registry row + this
  // bundled example + the json, with ZERO new resolver/command/core logic.
  connectv3: fileURLToPath(new URL('../examples/flows/connectv3.flows.json', import.meta.url)),
});

/** A `process.env`-shaped bag the command passes in (keeps env reads at the edge). */
export type EnvBag = Record<string, string | undefined>;

/**
 * The parsed-flags object the commands pass in. It carries booleans too, so the
 * helpers read it loosely and pick out only the string flags they need
 * (`dev`, `state-dir`, `spa-path`, and the per-repo `--<repo>` path pins).
 */
export type FlagBag = Record<string, unknown>;

/** Read a string-valued flag, or undefined when absent / not a string. */
function str(bag: FlagBag, key: string): string | undefined {
  const v = bag[key];
  return typeof v === 'string' ? v : undefined;
}

/** The result of discovering + loading a SPA's flows. */
export interface DiscoverResult {
  /** The SPA descriptor (registry row pre-load; the loaded manifest's `spa` is authoritative after). */
  spa: SpaDescriptor;
  /** The loaded + validated flow manifest. */
  manifest: FlowManifest;
  /** Where the manifest came from (a repo/override path, or the bundled example). */
  sourcePath: string;
  /** True iff we fell back to the package's bundled example (the repo hasn't authored one). */
  usedBundledExample: boolean;
}

/**
 * Locate + load a SPA's `flows.json`. Resolution order (highest precedence first):
 * `--spa-path`, then `$SAGA_E2E_SPA_PATHS`, then the registry repo path
 * (`$<repoEnvVar> ?? $DEV/<sub>` + `e2eDir/flows.json`). When nothing is found AND
 * the SPA is a built-in with a bundled example (today: `saga-dash`), the bundled
 * example is loaded as a template fallback and `usedBundledExample` is set so the
 * caller can SAY SO. Throws (helpful message) on an unknown SPA or a hard miss
 * with no fallback. A file that EXISTS but is malformed surfaces loudly (zod).
 */
export function discoverFlowManifest(spaId: string, flags: FlagBag, env: EnvBag): DiscoverResult {
  const spa = lookupSpa(spaId);
  if (!spa) {
    throw new Error(`unknown SPA '${spaId}' (known: ${knownSpaIds().join(', ')}). Pass --spa-path to point at a flows.json directly.`);
  }

  const envBag = overlayRepoEnv(env, flags);

  const extraPaths: string[] = [];
  const spaPath = str(flags, 'spa-path');
  if (spaPath) extraPaths.push(spaPath);
  extraPaths.push(...splitSpaPaths(env.SAGA_E2E_SPA_PATHS));

  const candidates = flowsCandidatePaths({ spa, env: envBag, extraPaths });
  const found = loadFlowsFrom(candidates);
  if (found.found) {
    return { spa, manifest: found.manifest, sourcePath: found.path, usedBundledExample: false };
  }

  // Fallback: the built-in bundled example (only for SPAs that ship one).
  const bundled = BUNDLED_EXAMPLE[spaId];
  if (bundled) {
    const fromBundle = loadFlowsFrom([bundled]);
    /* c8 ignore next — the bundled example ships with the package and always parses. */
    if (!fromBundle.found) throw new Error(`bundled example flows.json missing at ${bundled}`);
    return { spa, manifest: fromBundle.manifest, sourcePath: bundled, usedBundledExample: true };
  }

  throw new Error(found.message);
}

/**
 * Overlay the per-repo `--<repo>` flag pins + `--dev` onto a copy of `env`, keyed
 * by the env-var spelling the discover path resolver reads (`$<repoEnvVar>` /
 * `$DEV`). Mirrors up.sh's repo-path precedence.
 */
function overlayRepoEnv(env: EnvBag, flags: FlagBag): EnvBag {
  const out: EnvBag = { ...env };
  const dev = str(flags, 'dev');
  if (dev) out.DEV = dev;
  for (const kebab of Object.keys(REPO_ENV_VAR) as (keyof typeof REPO_ENV_VAR)[]) {
    const v = str(flags, kebab);
    if (v) out[REPO_ENV_VAR[kebab]] = v;
  }
  return out;
}

// ── runtime/context assembly (mirrors stack up's buildRuntime) ───────────────

/** The injected process/IO seams the StackApi runtime needs (from BaseCommand). */
export interface StackSeams {
  launcher: ServiceLauncher;
  meshExec: MeshExec;
  portProbe: PortProbe;
  dashFs: DashFs;
  prober: HealthProber;
  runner: Runner;
}

/**
 * Assemble the in-process `Runtime` for `makeStackApi` from the injected seams +
 * the resolved workspace, plus the full repo-root map (so the command can place
 * the Playwright cwd). `delegate` wires reset/login back to up.sh through the
 * caller's `runScript`. The native path drives the local `stack` lane.
 *
 * NOTE: this mirrors `commands/stack/up.ts::buildRuntime`. TODO(post-soak):
 * extract the shared builder once both call sites are proven, so there is one
 * source of truth for the launch context.
 */
export function buildStackContext(
  flags: FlagBag,
  seams: StackSeams,
  delegate: (plan: ScriptPlan) => Promise<number>,
): { runtime: Runtime; repoRoots: Record<RepoKey, string> } {
  const pinned: Partial<Record<RepoKey, string>> = {};
  for (const kebab of Object.keys(REPO_ENV_VAR) as (keyof typeof REPO_ENV_VAR)[]) {
    const value = str(flags, kebab);
    if (value) pinned[REPO_ENV_VAR[kebab] as RepoKey] = value;
  }
  const ctx: ScriptContext = { dev: str(flags, 'dev'), repoRoots: pinned };

  const repoRoots = {} as Record<RepoKey, string>;
  for (const repo of Object.keys(REPO_DEFAULT_DIR) as RepoKey[]) {
    repoRoots[repo] = resolveRepoRoot(repo, ctx);
  }

  const syntheticDevDir = scriptCwd({ repo: 'SOA', relPath: 'tools/synthetic-dev/up.sh' }, ctx);
  const launchContext = defaultLaunchContext({
    repoRoots,
    syntheticDevDir,
    pinoLevel: process.env.PINO_LOGGER_LEVEL,
    pinoIsExpressContext: process.env.PINO_LOGGER_ISEXPRESSCONTEXT,
  });

  const runtime: Runtime = {
    lane: 'stack',
    launchContext,
    soaRoot: repoRoots.SOA,
    sagaDashRoot: repoRoots.SAGA_DASH,
    launcher: seams.launcher,
    meshExec: seams.meshExec,
    portProbe: seams.portProbe,
    dashFs: seams.dashFs,
    prober: seams.prober,
    runner: seams.runner,
    tunnel: false,
    delegate,
  };

  return { runtime, repoRoots };
}

/**
 * Resolve a SPA's repo root from the discovery flags (honours `--<repo>` pins +
 * `--dev`), then join its `appDir` — the cwd Playwright runs in (matching
 * run-stack-e2e.sh's `cd $DASH`). Uses the SAME `$<repoEnvVar> ?? $DEV/<sub>`
 * precedence as flow discovery, so the launch + Playwright cwds always agree.
 */
export function resolveAppCwd(spa: SpaDescriptor, flags: FlagBag, env: EnvBag): string {
  const repoRoot = resolveSpaRepoRoot(spa, overlayRepoEnv(env, flags));
  return joinPath(repoRoot, spa.appDir);
}

/** Join a repo root + repo-relative subpath without depending on leading/trailing-slash shape. */
function joinPath(root: string, sub: string): string {
  return `${root.replace(/\/+$/, '')}/${sub.replace(/^\/+/, '')}`;
}

// ── playwright invocation (pure) ─────────────────────────────────────────────

/**
 * The `pnpm exec playwright test …` argv for a resolved flow. The CLI never
 * parses the SPA's Playwright config — it passes `--config` (verbatim,
 * appDir-relative), `--project` (the terminal stage), an optional
 * `--grep-invert @interactive` (pipeline runs exclude the interactive harness),
 * `--headed` (foreground flows), then any user passthrough (after `--`).
 */
export function playwrightArgv(resolved: ResolvedFlow, passthrough: string[] = []): string[] {
  const argv = [
    'exec',
    'playwright',
    'test',
    `--config=${resolved.playwright.config}`,
    '--project',
    resolved.playwright.project,
  ];
  if (resolved.playwright.grepInvert) argv.push('--grep-invert', resolved.playwright.grepInvert);
  if (resolved.playwright.headed) argv.push('--headed');
  argv.push(...passthrough);
  return argv;
}

/**
 * The env overlaid on the Playwright child: the centralized clamped date env
 * (`computeEnv` — the Monday-flake fix, plus the flow's own `env`), plus
 * `PLAYWRIGHT_LANE` for the non-stack (deployed) lanes. `now` is supplied by the
 * command (`new Date()`); this never reads the clock.
 */
export function playwrightEnv(resolved: ResolvedFlow, now: Date, lane: Lane): Record<string, string> {
  const env = computeEnv(resolved.flow, now);
  if (lane !== 'stack') env.PLAYWRIGHT_LANE = lane;
  return env;
}

// ── dry-run / JSON projection (pure) ──────────────────────────────────────────

/** A serializable projection of a resolved flow (what `--dry-run` prints). */
export interface ResolvedFlowDescription {
  spa: string;
  flow: string;
  lane: Lane;
  stages: string[];
  reset: boolean;
  foreground: boolean;
  headed: boolean;
  requiredSystems: ServiceId[];
  closure: { services: ServiceId[]; databases: string[]; mesh: string[] };
  seed: { offline: string[]; online: string[]; skipped: { id: string; reason: string }[] } | null;
  playwright: { cwd: string; config: string; project: string; argv: string[] };
  occurrenceDate: string;
  env: Record<string, string>;
  prerequisite: ResolvedFlowDescription | null;
}

/** Options for the pure projection. */
export interface DescribeOptions {
  now: Date;
  lane: Lane;
  appCwd: string;
  passthrough: string[];
  skipReset: boolean;
  manifest?: Manifest;
}

/**
 * Pure projection of a `ResolvedFlow` into the dry-run/JSON shape: the closure,
 * the effective seed plan (composed over the closure, only when this flow resets
 * + seeds), the exact Playwright argv + cwd, and the injected occurrence date.
 * Recurses the prerequisite. Touches NO seam, spawns nothing.
 */
export function describeResolved(resolved: ResolvedFlow, opts: DescribeOptions): ResolvedFlowDescription {
  const dateEnv = computeEnv(resolved.flow, opts.now);
  const effectiveReset = resolved.reset && !opts.skipReset;
  const seed =
    effectiveReset && resolved.seedSelection
      ? (() => {
          const plan = composeSeedPlan(resolved.seedSelection, new Set(resolved.closure.services), new Set<ServiceId>());
          return {
            offline: plan.offline.map((s) => s.id),
            online: plan.online.map((s) => s.id),
            skipped: plan.skipped.map((s) => ({ id: s.id, reason: s.reason })),
          };
        })()
      : null;

  return {
    spa: resolved.spa.id,
    flow: resolved.flow.name,
    lane: opts.lane,
    stages: resolved.stages.map((s) => s.id),
    reset: effectiveReset,
    foreground: resolved.foreground,
    headed: resolved.playwright.headed,
    requiredSystems: resolved.requiredSystems,
    closure: {
      services: resolved.closure.services,
      databases: resolved.closure.databases,
      mesh: resolved.closure.mesh,
    },
    seed,
    playwright: {
      cwd: opts.appCwd,
      config: resolved.playwright.config,
      project: resolved.playwright.project,
      argv: playwrightArgv(resolved, opts.passthrough),
    },
    occurrenceDate: dateEnv[ENV_OCCURRENCE_DATE] ?? '',
    env: playwrightEnv(resolved, opts.now, opts.lane),
    // The prerequisite always builds the end-state headless + owns its own reset;
    // it gets no user passthrough.
    prerequisite: resolved.prerequisite
      ? describeResolved(resolved.prerequisite, { ...opts, passthrough: [], skipReset: false })
      : null,
  };
}

// ── execution ─────────────────────────────────────────────────────────────────

/** Raised when a native pre-Playwright stage (up/reset/seed/verify) fails. */
export class FlowExecError extends Error {}

/** Dependencies the executor needs from the command (all injected/resolved). */
export interface ExecDeps {
  api: StackApi;
  runner: Runner;
  appCwd: string;
  now: Date;
  /** Service manifest for the verify probe list (defaults to the frozen one). */
  manifest?: Manifest;
  /** Sink for progress lines (the command's `log`). */
  log: (line: string) => void;
}

/** Per-run knobs. */
export interface ExecOptions {
  lane: Lane;
  /** Force-skip the reset+seed (the `--skip-reset` / `--reuse` knob). */
  skipReset: boolean;
  /** Playwright passthrough args (after `--`); applied to THIS flow only, not the prerequisite. */
  passthrough: string[];
}

/**
 * Execute a resolved flow end-to-end and return the Playwright exit code (0 = ok).
 *
 * Order (stack lane): recurse the prerequisite (headless, skip-reset, no
 * passthrough; a non-zero prerequisite aborts) → `StackApi.up(closure)` →
 * (reset+seed unless skipped) → `verify({tolerate:[spa.system]})` → spawn
 * Playwright via the Runner with the clamped date env. A failed up/reset/seed/
 * verify throws `FlowExecError`; a Playwright failure is returned as the exit
 * code (a legitimate test failure, propagated by the caller).
 *
 * Non-stack (deployed/sandbox) lanes have NO local stack to bring up: they skip
 * the up/reset/seed/verify entirely and only spawn Playwright with
 * `PLAYWRIGHT_LANE` set — mirroring run-stack-e2e.sh's `--sandbox` branch.
 */
export async function executeResolvedFlow(
  resolved: ResolvedFlow,
  deps: ExecDeps,
  opts: ExecOptions,
): Promise<number> {
  const m = deps.manifest ?? serviceManifest;

  // 0. Prerequisite first (e.g. connect-session ⇐ journey through 'schedule').
  if (resolved.prerequisite) {
    deps.log(`==> prerequisite: ${resolved.prerequisite.flow.name} (through '${resolved.prerequisite.stages.at(-1)?.id}', headless)`);
    const preCode = await executeResolvedFlow(resolved.prerequisite, deps, {
      lane: opts.lane,
      skipReset: false,
      passthrough: [],
    });
    if (preCode !== 0) {
      throw new FlowExecError(`prerequisite flow '${resolved.prerequisite.flow.name}' failed (exit ${preCode})`);
    }
  }

  const services = resolved.closure.services;

  if (opts.lane === 'stack') {
    // 1. native bring-up.
    deps.log(`==> up: ${services.length} service(s) [${services.join(', ')}]`);
    const up = await deps.api.up(services);
    if (!up.ok) {
      throw new FlowExecError(`native bring-up failed${up.failedAt ? ` at ${up.failedAt}` : ''}`);
    }

    // 2. reset + seed (coupled; skipped on --skip-reset or when a prerequisite built the state).
    const effectiveReset = resolved.reset && !opts.skipReset;
    if (effectiveReset) {
      deps.log('==> reset (delegated to up.sh --legacy) + native seed');
      // e2e keeps the whole-stack bash reset (up.sh --reset) for now — the native
      // per-DB reset (M8 R4) is the `stack reset` default; e2e opts into `--legacy`.
      const reset = await deps.api.reset(services, { legacy: true });
      if (reset.code !== 0) throw new FlowExecError(`reset failed (up.sh exit ${reset.code})`);
      if (resolved.seedSelection) {
        const plan = composeSeedPlan(resolved.seedSelection, new Set(services), new Set<ServiceId>());
        const seeded = await deps.api.seed(plan);
        if (!seeded.ok) throw new FlowExecError(`seed failed at ${seeded.failed}`);
      }
    } else {
      deps.log('==> skip reset/seed (reuse current stack state)');
    }

    // 3. verify (tolerate the SPA's own frontend service being red — branch posture / dev server).
    const probes = healthProbes(m, services);
    const verified = await deps.api.verify(probes, { tolerate: [resolved.spa.system] });
    if (!verified.passed) {
      const down = verified.rows.filter((r) => !r.ok && !r.tolerated).map((r) => r.id);
      throw new FlowExecError(`verify failed — unhealthy: ${down.join(', ')}`);
    }
  } else {
    deps.log(`==> ${opts.lane} lane: no local stack to bring up; running Playwright against the deployed composition`);
  }

  // 4. Playwright (foreground, stdio inherited). The clamped date env is overlaid.
  const argv = playwrightArgv(resolved, opts.passthrough);
  const env = playwrightEnv(resolved, deps.now, opts.lane);
  deps.log(`==> playwright: ${resolved.flow.name} — pnpm ${argv.join(' ')} (cwd ${deps.appCwd})`);
  const { code } = await deps.runner.run({
    cwd: deps.appCwd,
    command: 'pnpm',
    args: argv,
    env,
    stdio: 'inherit',
  });
  return code;
}
