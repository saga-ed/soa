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

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSeedPlan } from './core/seed/compose-seed-plan.js';
import { computeEnv, ENV_OCCURRENCE_DATE, ENV_TERM_END, ENV_TERM_START } from './core/flow/env.js';
import { checkpointFixtureId, evaluateCheckpoint, stagePrefixHash } from './core/flow/checkpoint.js';
import type { SnapshotFlowBlock } from './core/snapshot/index.js';
import type { CheckpointStore } from './runtime/checkpoint-store.js';
import {
  flowsCandidatePaths,
  knownSpaIds,
  lookupSpa,
  resolveRepoRoot as resolveSpaRepoRoot,
  splitSpaPaths,
} from './core/flow/index.js';
import type { ResolvedFlow, SpaDescriptor } from './core/flow/index.js';
import { deriveInstance } from './core/derive-instance.js';
import type { InstanceProfile } from './core/derive-instance.js';
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
  resolveVendorScript,
} from './runtime/index.js';
import type {
  DashFs,
  HealthProber,
  MeshExec,
  PgProbe,
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
  /**
   * The native-prep seams wired into the runtime so the stack provisions/migrates
   * itself (R1 build → R2 provision → R3 migrate) instead of leaning on a prior
   * up.sh run. Since FLIP 3 these are wired at EVERY slot (including slot 0) — the
   * e2e's native reset replaced up.sh's prep migrate, so slot 0 must run prep too or
   * NOTHING migrates the schema and the seed fails (TableDoesNotExist). The command
   * builds them from `getPgProbe()`/`getPrepFreshCheck()`/… and passes them through.
   */
  pgProbe?: PgProbe;
  prepIsFresh?: (repoRoot: string) => boolean;
  prepDbGenerateScan?: (repoRoot: string) => string[];
  repoDirExists?: (dir: string) => boolean;
  skipPrep?: boolean;
}

/**
 * Assemble the in-process `Runtime` for `makeStackApi` from the injected seams +
 * the resolved workspace, plus the full repo-root map (so the command can place
 * the Playwright cwd). `delegate` wires reset/login back to up.sh through the
 * caller's `runScript`. The native path drives the local `stack` lane.
 *
 * SLOT PARITY (M7): mirrors `commands/stack/up.ts::buildRuntime` → the shared
 * `BaseCommand.buildNativeRuntime` for slots. It threads the resolved slot
 * `profile` (`deriveInstance({slot})`, passed in by the command) exactly as the
 * stack path does: `profile.portOverrides` + `profile.meshOffset` feed
 * `defaultLaunchContext` (so `launchContext.ports` carry the offset). The
 * native-prep seams (`pgProbe`/`prepIsFresh`/…) are wired at EVERY slot (see
 * below); at slot > 0 it additionally sets `runtime.{slot, meshProject:
 * profile.project, meshOffset}` so the slot's DBs provision + migrate on their OWN
 * offset ports/project. The per-slot container-env (`profile.containerEnv` /
 * `snapshotsDir`) and the launcher's `profile.stateDir` are applied by the COMMAND
 * (`applyInstanceEnv` + `getLauncher(stateDir)`) before this is called, so the
 * seam-injection pattern (command builds seams, this composes them) holds.
 *
 * PREP AT EVERY SLOT (FLIP 3): the native-prep seams are wired UNCONDITIONALLY,
 * including slot 0. FLIP 3 made the e2e's slot-0 reset native (no more `up.sh
 * --reset`), which killed the only thing that used to migrate the schema at slot 0.
 * So `StackApi.up` must run R1 build → R2 provision → R3 migrate at slot 0 too, or
 * the stack comes up with 0 migrations and `seed-dev-user` fails (TableDoesNotExist).
 * The slot-OFFSET fields (`slot`/`meshProject`/`meshOffset`) remain slot > 0-gated —
 * slot 0 keeps the base mesh project + base ports.
 */
export function buildStackContext(
  flags: FlagBag,
  seams: StackSeams,
  delegate: (plan: ScriptPlan) => Promise<number>,
  profile: InstanceProfile = deriveInstance({ slot: 0 }),
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

  // rtsm-api's non-tunnel FLEET_CONFIG_PATH reads `${VENDOR_DIR}/rtsm-fleet-local.json`;
  // point VENDOR_DIR at the CLI's VENDORED copy (Phase-2 DECOUPLING), NOT tools/synthetic-dev.
  const vendorDir = dirname(resolveVendorScript('rtsm-fleet-local.json'));
  // Thread the slot's port-override map + mesh offset (byte-identical base context
  // at slot 0 — `deriveInstance` guarantees slot-0 overrides resolve the defaults).
  const launchContext = defaultLaunchContext({
    repoRoots,
    vendorDir,
    portOverrides: profile.portOverrides,
    meshOffset: profile.meshOffset,
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
    // FLIP 3: wire the native-prep seams at EVERY slot (including slot 0) so the e2e's
    // native `StackApi.up` runs R1 build → R2 provision → R3 migrate before launch+seed,
    // regardless of slot. Slot 0 used to rely on `up.sh --reset`'s own prep migrate to
    // create the DB schema; now that the reset is native (and up.sh is gone from the e2e
    // path), NOTHING would migrate at slot 0 without this — seed-dev-user then fails with
    // TableDoesNotExist. So these seams are UNCONDITIONAL.
    pgProbe: seams.pgProbe,
    skipPrep: seams.skipPrep,
    prepIsFresh: seams.prepIsFresh,
    prepDbGenerateScan: seams.prepDbGenerateScan,
    repoDirExists: seams.repoDirExists,
    // M7 slot > 0 ONLY: namespace the mesh (`soa-s<N>`) + carry the offset so the slot's
    // fresh DBs provision + migrate on their OWN offset ports/project. OMITTED at slot 0,
    // so the pre-slot runtime keeps the base mesh project + base ports.
    ...(profile.slot > 0
      ? {
          slot: profile.slot,
          meshProject: profile.project,
          meshOffset: profile.meshOffset,
        }
      : {}),
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
export function playwrightArgv(
  resolved: ResolvedFlow,
  passthrough: string[] = [],
  /**
   * M14 per-stage override (bake/--from spawns): target THIS project instead
   * of the terminal, and (`noDeps`) break the config-side dependency chain so
   * the spawn runs exactly one stage instead of replaying 1..N. Absent ⇒
   * byte-identical to the pre-M14 argv.
   */
  stage?: { project: string; noDeps: boolean },
): string[] {
  const argv = [
    'exec',
    'playwright',
    'test',
    `--config=${resolved.playwright.config}`,
    '--project',
    stage?.project ?? resolved.playwright.project,
  ];
  if (stage?.noDeps) argv.push('--no-deps');
  if (resolved.playwright.grepInvert) argv.push('--grep-invert', resolved.playwright.grepInvert);
  if (resolved.playwright.headed) argv.push('--headed');
  argv.push(...passthrough);
  return argv;
}

/**
 * The `PLAYWRIGHT_<X>_URL` env key → the manifest `ServiceId` whose RESOLVED
 * (offset-carrying) stack port backs it. This is the crux of slot isolation for
 * the Playwright run: the specs' `e2e/fixtures/lane.ts` reads each service base
 * URL as `process.env.PLAYWRIGHT_<X>_URL ?? http://localhost:<base port>`, and the
 * Playwright config's `baseURL` is `PLAYWRIGHT_BASE_URL ?? http://localhost:8900`.
 * By injecting each key from `launchContext.ports[svc]` (= manifest base + slot
 * offset), a slot-1 journey drives saga-dash on :9900 and hits iam :4010 /
 * scheduling :4008 / sessions :4007 / … instead of slot 0's base ports. Keyed to
 * the exact env vars `lane.ts` consumes today (nothing invented).
 */
export const PLAYWRIGHT_SERVICE_URL_ENV: Readonly<Record<string, ServiceId>> = Object.freeze({
  PLAYWRIGHT_BASE_URL: 'saga-dash', // the dash frontend origin (Playwright `baseURL`)
  PLAYWRIGHT_IAM_URL: 'iam-api',
  PLAYWRIGHT_SIS_URL: 'sis-api',
  PLAYWRIGHT_PROGRAMS_URL: 'programs-api',
  PLAYWRIGHT_SCHEDULING_URL: 'scheduling-api',
  PLAYWRIGHT_SESSIONS_URL: 'sessions-api',
  PLAYWRIGHT_ADS_ADM_URL: 'ads-adm-api',
  PLAYWRIGHT_CONNECT_URL: 'connect-web',
});

/**
 * Build the stack-lane service-URL env from RESOLVED ports (each = manifest base +
 * slot offset). At slot 0 the ports are the base ports, so this yields the SAME
 * URLs `lane.ts` would default to (behaviour-identical); at slot N > 0 every URL
 * carries the `N * 1000` offset. Derived from `launchContext.ports` — never a
 * hardcoded port — so a re-banded/remapped service slots for free. A service with
 * no resolved port is omitted rather than emitting `localhost:undefined`.
 */
export function serviceUrlEnv(ports: Partial<Record<ServiceId, number>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, svc] of Object.entries(PLAYWRIGHT_SERVICE_URL_ENV)) {
    const port = ports[svc];
    if (port !== undefined) env[key] = `http://localhost:${port}`;
  }
  return env;
}

/**
 * The env overlaid on the Playwright child: the centralized clamped date env
 * (`computeEnv` — the Monday-flake fix, with the flow's own `env` merged last so a
 * date-fixed flow's date pins win), THEN the offset-carrying stack-lane service
 * URLs (from the resolved `ports`, so each slot targets its OWN ports), plus
 * `PLAYWRIGHT_LANE` for the non-stack (deployed) lanes. The service URLs are
 * overlaid AFTER the date env so the slot offset ALWAYS wins for the
 * `PLAYWRIGHT_*_URL` keys — a `flow.env` that pins a service URL can never override
 * the slot offset and point slot > 0 back at slot 0's base port (the split-brain
 * guard), while `flow.env` keeps winning for the date env. On a deployed lane the
 * service URLs are the lane's own hostnames (resolved in `lane.ts`), NOT localhost,
 * so we do NOT inject them. `now` is supplied by the command (`new Date()`); this
 * never reads the clock.
 */
export function playwrightEnv(
  resolved: ResolvedFlow,
  now: Date,
  lane: Lane,
  ports?: Partial<Record<ServiceId, number>>,
  /**
   * M14 §2.2: the checkpoint's BAKED date env — a `--from` run must export the
   * dates the restored state embeds, not today's clamp. Spread AFTER
   * `computeEnv` (beats the clamp AND `flow.env` — at bake time computeEnv ran
   * with the same flow.env, so what got baked is what a flow pin produced) but
   * BEFORE the service URLs, so the slot offset still always wins for
   * `PLAYWRIGHT_*_URL` keys.
   */
  dateOverrides?: Record<string, string>,
): Record<string, string> {
  // The date env (with `flow.env` merged LAST inside `computeEnv`) comes first, so
  // a flow's own env keeps winning for the occurrence-date clamp. Then, on the
  // stack lane, the slot-offset service URLs are overlaid AFTER — so the slot
  // offset ALWAYS wins for the PLAYWRIGHT_*_URL keys and a `flow.env` that pins a
  // service URL can never point slot > 0 back at slot 0's base port (same
  // split-brain class as the dash config.local.json offset). On a deployed lane
  // the service URLs are the lane's own hostnames (resolved in `lane.ts`), so we
  // do NOT inject/override them.
  const env: Record<string, string> = {
    ...computeEnv(resolved.flow, now),
    ...(dateOverrides ?? {}),
    ...(lane === 'stack' && ports ? serviceUrlEnv(ports) : {}),
  };
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
  /** M14: the checkpoint a --from run will restore (validated at run time, not here — pure). */
  checkpoint: { fixtureId: string; predecessor: string } | null;
  /** M14: the per-stage checkpoint fixtureIds a --snapshot-stages run bakes. */
  bakeCheckpoints: string[] | null;
}

/** Options for the pure projection. */
export interface DescribeOptions {
  now: Date;
  lane: Lane;
  appCwd: string;
  passthrough: string[];
  skipReset: boolean;
  manifest?: Manifest;
  /** M14: project the per-stage bake fixtureIds (`--snapshot-stages` dry-run). */
  snapshotStages?: boolean;
  /**
   * Resolved per-service stack ports (`launchContext.ports`, offset-carrying) —
   * threaded into the Playwright env so the dry-run shows the slot's OFFSET service
   * URLs. Absent (slot 0 caller may still pass the base map) ⇒ no service URLs.
   */
  ports?: Partial<Record<ServiceId, number>>;
  /**
   * Services excluded from THIS slot's closure (`profile.excludedServices`) — the
   * literal-port + connect frontends that would collide with slot 0. Empty at slot 0.
   */
  excluded?: Set<ServiceId>;
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
  // Drop the slot's excluded services (literal-port + connect frontends) from the
  // closure so the dry-run matches what a `--slot N` run actually brings up. Empty
  // set at slot 0 ⇒ the full closure, byte-identical.
  const excluded = opts.excluded ?? new Set<ServiceId>();
  const services = resolved.closure.services.filter((id) => !excluded.has(id));
  const seed =
    effectiveReset && resolved.seedSelection
      ? (() => {
          const plan = composeSeedPlan(resolved.seedSelection, new Set(services), new Set<ServiceId>());
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
      services,
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
    env: playwrightEnv(resolved, opts.now, opts.lane, opts.ports),
    // The prerequisite always builds the end-state headless + owns its own reset;
    // it gets no user passthrough.
    prerequisite: resolved.prerequisite
      ? describeResolved(resolved.prerequisite, { ...opts, passthrough: [], skipReset: false })
      : null,
    checkpoint: resolved.checkpoint
      ? {
          fixtureId: checkpointFixtureId(
            resolved.spa.id,
            resolved.flow.name,
            resolved.checkpoint.predecessor,
            resolved.checkpoint.predecessorPosition,
          ),
          predecessor: resolved.checkpoint.predecessor.id,
        }
      : null,
    bakeCheckpoints:
      opts.snapshotStages === true
        ? resolved.stages.map((s) =>
            checkpointFixtureId(
              resolved.spa.id,
              resolved.flow.name,
              s,
              resolved.flow.stages.findIndex((f) => f.id === s.id) + 1,
            ),
          )
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
  /**
   * The stack instance slot (M7). Threaded only for logging + the per-slot service
   * exclusion now — since FLIP 3 the reset runs NATIVELY at EVERY slot (it no longer
   * delegates to `up.sh --reset` at slot 0), so this no longer selects the reset path.
   */
  slot?: number;
  /**
   * Resolved per-service stack ports (`launchContext.ports`, offset-carrying),
   * injected into the Playwright env so specs drive the slot's OWN service URLs.
   */
  ports?: Partial<Record<ServiceId, number>>;
  /**
   * Services excluded from THIS slot's bring-up (`profile.excludedServices`).
   * Filtered out of the closure before up/reset/seed/verify. Empty at slot 0.
   */
  excluded?: Set<ServiceId>;
  /**
   * M14: the stage-checkpoint store (bake + restore). Constructed by the
   * command AFTER `applyInstanceEnv` (so it targets the slot's snapshot root +
   * containers). Absent ⇒ `--from`/`--snapshot-stages` paths are unavailable
   * (the second caller, `e2e connect`, never sets it).
   */
  checkpoints?: CheckpointStore;
}

/** Per-run knobs. */
export interface ExecOptions {
  lane: Lane;
  /** Force-skip the reset+seed (the `--skip-reset` / `--reuse` knob). */
  skipReset: boolean;
  /** Playwright passthrough args (after `--`); applied to THIS flow only, not the prerequisite. */
  passthrough: string[];
  /**
   * M14 bake mode: spawn Playwright once per stage (`--no-deps` past the
   * first) and store a checkpoint after each green stage. Kept in OPTIONS so
   * the prerequisite recursion (which passes deps down unchanged but rebuilds
   * opts) never inherits it.
   */
  snapshotStages?: boolean;
  /** M14 §2.2: downgrade the >7-day checkpoint staleness violation to a warning. */
  fromStaleOk?: boolean;
  /**
   * M14 §2.3 (advisory): the SPA checkout's HEAD at run time — stamped into
   * bakes, compared (WARN-only) on restores. Absent when the SPA dir is not a
   * git checkout (e.g. hermetic tests).
   */
  spaHead?: { sha: string; dirty: boolean };
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

  // Drop this slot's excluded services (literal-port + connect frontends that would
  // collide with slot 0) from the closure BEFORE up/reset/seed/verify. Empty set at
  // slot 0 ⇒ the full closure, byte-identical.
  const excluded = deps.excluded ?? new Set<ServiceId>();
  const services = resolved.closure.services.filter((id) => !excluded.has(id));
  const slot = deps.slot ?? 0;

  // M14: the baked date env a --from restore mandates for the Playwright child
  // (§2.2 — restored data and running specs must agree on the dates).
  let restoredDates: SnapshotFlowBlock['dates'] | undefined;
  if (resolved.checkpoint && opts.lane !== 'stack') {
    throw new FlowExecError('--from restores a LOCAL stack checkpoint — it requires the stack lane');
  }
  if (opts.snapshotStages === true && opts.lane !== 'stack') {
    throw new FlowExecError(
      '--snapshot-stages bakes LOCAL stack checkpoints — it requires the stack lane (a deployed-lane run would dump unrelated local container state)',
    );
  }
  if (opts.snapshotStages === true && !resolved.flow.progressive) {
    throw new FlowExecError('--snapshot-stages requires a progressive flow (stage checkpoints are replay prefixes)');
  }

  if (opts.lane === 'stack') {
    // 1. native bring-up.
    deps.log(`==> up: ${services.length} service(s) [${services.join(', ')}]`);
    const up = await deps.api.up(services);
    if (!up.ok) {
      throw new FlowExecError(`native bring-up failed${up.failedAt ? ` at ${up.failedAt}` : ''}`);
    }

    // 2a. M14 --from: restore the predecessor stage's checkpoint — the state
    // source replacing the reset+seed AND the Playwright replay of stages
    // 1..from-1. Gated on resolved.checkpoint (never on effectiveReset:
    // resolved.reset is already false for a --from window by construction).
    if (resolved.checkpoint) {
      restoredDates = await restoreCheckpoint(resolved, deps, opts, services, m);
    }

    // 2b. reset + seed (coupled; skipped on --skip-reset or when a prerequisite built the state).
    const effectiveReset = resolved.reset && !opts.skipReset;
    if (effectiveReset) {
      // FLIP 3: the e2e reset is NATIVE at EVERY slot now (M8 R4 — slot-aware via the
      // runtime's offset + slot containers). Slot 0 used to delegate to `up.sh --reset`,
      // but that died whenever soa was on a feature branch (the observed slot-0 e2e
      // failure) and up.sh is hardcoded to slot 0 anyway. This is a closure-scoped
      // native reset (NOT byte-identical to up.sh --reset: scoped to the flow's closure,
      // truncating neededDbs(closure) rather than up.sh's fixed 9-DB list, and it adds a
      // ledger_local migrate-reset up.sh doesn't do). `e2e run` therefore NEVER delegates
      // its reset to up.sh.
      deps.log(`==> reset (native${slot > 0 ? `, slot ${slot}` : ''}) + native seed`);
      const reset = await deps.api.reset(services);
      if (reset.code !== 0) {
        throw new FlowExecError(`reset failed (native exit ${reset.code})`);
      }
      if (resolved.seedSelection) {
        const plan = composeSeedPlan(resolved.seedSelection, new Set(services), new Set<ServiceId>());
        const seeded = await deps.api.seed(plan);
        if (!seeded.ok) throw new FlowExecError(`seed failed at ${seeded.failed}`);
      }
    } else if (!resolved.checkpoint) {
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

  // 4. Playwright (foreground, stdio inherited). The clamped date env (or the
  // checkpoint's BAKED dates under --from) + the slot's offset service URLs are
  // overlaid (so a slot's specs drive its OWN ports).
  const dateOverrides = restoredDates
    ? {
        [ENV_OCCURRENCE_DATE]: restoredDates.occurrenceDate,
        [ENV_TERM_START]: restoredDates.termStart,
        [ENV_TERM_END]: restoredDates.termEnd,
      }
    : undefined;
  const env = playwrightEnv(resolved, deps.now, opts.lane, deps.ports, dateOverrides);

  const spawn = async (stage?: { project: string; noDeps: boolean }): Promise<number> => {
    const argv = playwrightArgv(resolved, opts.passthrough, stage);
    deps.log(`==> playwright: ${resolved.flow.name} — pnpm ${argv.join(' ')} (cwd ${deps.appCwd})`);
    const { code } = await deps.runner.run({
      cwd: deps.appCwd,
      command: 'pnpm',
      args: argv,
      env,
      stdio: 'inherit',
    });
    return code;
  };

  // Default path: ONE spawn with the terminal project — Playwright's config-side
  // dependency chain replays 1..N (byte-identical to pre-M14). The per-stage
  // ladder exists ONLY for M14: baking needs a checkpoint between stages, and a
  // --from window must NOT let the dependency chain replay the restored prefix.
  const perStage = opts.snapshotStages === true || resolved.checkpoint !== undefined;
  if (!perStage) return spawn();

  if (opts.snapshotStages === true && deps.checkpoints === undefined) {
    throw new FlowExecError('--snapshot-stages requires the checkpoint store (internal wiring error)');
  }

  for (const stage of resolved.stages) {
    // The FIRST stage of the whole flow keeps its config dependencies — its only
    // edge is the cheap coherence gate (e.g. stage-0-coherence), which a bake-
    // from-scratch run should still pass through. Every later spawn breaks the
    // chain (--no-deps) so earlier stages are never replayed.
    const isFlowFirst = resolved.flow.stages[0]?.id === stage.id;
    const code = await spawn({ project: stage.project, noDeps: !isFlowFirst });
    if (code !== 0) {
      // No checkpoint for a red stage — and stop the ladder (later checkpoints
      // would capture state the failed stage never produced).
      return code;
    }
    if (opts.snapshotStages === true) {
      await bakeStageCheckpoint(resolved, stage, services, env, deps, opts, m);
    }
  }
  return 0;
}

/** M14 §1.2: load + validate + restore the predecessor checkpoint; returns its baked dates. */
async function restoreCheckpoint(
  resolved: ResolvedFlow,
  deps: ExecDeps,
  opts: ExecOptions,
  services: ServiceId[],
  m: Manifest,
): Promise<SnapshotFlowBlock['dates']> {
  const cp = resolved.checkpoint as NonNullable<ResolvedFlow['checkpoint']>;
  if (deps.checkpoints === undefined) {
    throw new FlowExecError('--from requires the checkpoint store (internal wiring error)');
  }

  const fixtureId = checkpointFixtureId(
    resolved.spa.id,
    resolved.flow.name,
    cp.predecessor,
    cp.predecessorPosition,
  );
  const snapshot = deps.checkpoints.load(fixtureId);
  if (snapshot === null) {
    // Plan §1.2: list the stages that ARE baked so the fix is self-evident.
    const baked = resolved.flow.stages
      .filter((s, i) => deps.checkpoints?.load(checkpointFixtureId(resolved.spa.id, resolved.flow.name, s, i + 1)))
      .map((s) => s.id);
    throw new FlowExecError(
      `no checkpoint '${fixtureId}' — baked stages: ${baked.join(', ') || '(none)'}. Bake first:\n` +
        `  ss e2e run ${resolved.spa.id}/${resolved.flow.name} --snapshot-stages --headless`,
    );
  }

  const verdict = evaluateCheckpoint(
    snapshot.flow,
    {
      spaId: resolved.spa.id,
      flowName: resolved.flow.name,
      stageId: cp.predecessor.id,
      prefixHash: stagePrefixHash(resolved.flow, cp.producingStages),
      seedProfile: resolved.seedSelection?.profile,
      currentSpaHead: opts.spaHead?.sha,
    },
    deps.now,
    opts.fromStaleOk === true,
  );

  // The checkpoint must COVER the window's state: any DB a window stage needs
  // that the bake never dumped would keep un-reset leftover rows (a full replay
  // would have reset+seeded it). Bake wider (--through) or re-bake.
  const dumped = new Set(snapshot.databases.map((d) => d.db));
  const missing = [...new Set(services.flatMap((id) => m.services[id]?.databases ?? []))].filter(
    (db) => !dumped.has(db),
  );
  if (missing.length > 0) {
    verdict.violations.push(
      `the checkpoint does not cover the window's database(s): ${missing.join(', ')} — ` +
        'it was baked from a narrower closure; re-bake with a wider --through',
    );
    verdict.ok = false;
  }

  for (const w of verdict.warnings) deps.log(`⚠ checkpoint: ${w}`);
  if (!verdict.ok) {
    throw new FlowExecError(
      `checkpoint '${fixtureId}' failed validation:\n` + verdict.violations.map((v) => `  ✗ ${v}`).join('\n'),
    );
  }

  const flowBlock = snapshot.flow as SnapshotFlowBlock; // verdict.ok ⇒ present
  deps.log(`==> restore: ${fixtureId} (baked ${flowBlock.bakedAt}, occurrence ${flowBlock.dates.occurrenceDate})`);
  try {
    await deps.checkpoints.restore(snapshot, { currentProfile: resolved.seedSelection?.profile });
  } catch (err) {
    throw new FlowExecError((err as Error).message);
  }
  return flowBlock.dates;
}

/** M14 §1.1: overwrite-store the checkpoint for a just-green stage. */
async function bakeStageCheckpoint(
  resolved: ResolvedFlow,
  stage: ResolvedFlow['stages'][number],
  services: ServiceId[],
  env: Record<string, string>,
  deps: ExecDeps,
  opts: ExecOptions,
  m: Manifest,
): Promise<void> {
  const checkpoints = deps.checkpoints as NonNullable<ExecDeps['checkpoints']>;
  const position = resolved.flow.stages.findIndex((s) => s.id === stage.id) + 1;
  const fixtureId = checkpointFixtureId(resolved.spa.id, resolved.flow.name, stage, position);

  // The bake scope is the SLOT-FILTERED closure's DB set (post-closure exclusion,
  // same rule as `snapshot store --slot N`) — never dump DBs the slot never provisioned.
  const dbs = [...new Set(services.flatMap((id) => m.services[id]?.databases ?? []))];

  await checkpoints.bake({
    fixtureId,
    // No fabricated default: a seedless flow's checkpoint says so ('unseeded'
    // never false-matches a real profile in the restore-time double guard).
    profile: resolved.seedSelection?.profile ?? 'unseeded',
    dbs,
    flow: {
      spa: resolved.spa.id,
      flow: resolved.flow.name,
      stageId: stage.id,
      ...(stage.phase !== undefined ? { phase: stage.phase } : {}),
      prefixHash: stagePrefixHash(resolved.flow, resolved.flow.stages.slice(0, position)),
      ...(resolved.seedSelection?.profile !== undefined ? { seedProfile: resolved.seedSelection.profile } : {}),
      dates: {
        occurrenceDate: env[ENV_OCCURRENCE_DATE] ?? '',
        termStart: env[ENV_TERM_START] ?? '',
        termEnd: env[ENV_TERM_END] ?? '',
      },
      ...(opts.spaHead !== undefined ? { spaHead: opts.spaHead } : {}),
      bakedAt: deps.now.toISOString(),
    },
  });
  deps.log(`==> checkpoint: baked ${fixtureId}`);
}
