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
import { seedStepLabel } from './core/seed/datasets.js';
import { computeEnv, ENV_OCCURRENCE_DATE, ENV_TERM_END, ENV_TERM_START } from './core/flow/env.js';
import { checkpointFixtureId } from './core/flow/checkpoint.js';
import { bakeStageCheckpoint, FlowExecError, restoreCheckpoint } from './e2e-checkpoint-exec.js';
import type { SnapshotFlowBlock } from './core/snapshot/index.js';
import type { CheckpointStore } from './runtime/checkpoint-store.js';
import {
  flowsCandidatePaths,
  knownSpaIds,
  lookupSpa,
  resolveRepoRoot as resolveSpaRepoRoot,
  splitSpaPaths,
} from './core/flow/index.js';
import type { FlowDef, ResolvedFlow, SpaDescriptor } from './core/flow/index.js';
import { buildDevLoginRequest } from './core/login.js';
import type { PersonaPreflight, SettleBarrier } from './runtime/settle-barrier.js';
import { deriveInstance } from './core/derive-instance.js';
import type { InstanceProfile } from './core/derive-instance.js';
import { defaultLaunchContext } from './core/launch-plan.js';
import { manifest as serviceManifest } from './core/manifest/index.js';
import type { Manifest, RepoKey, ServiceId } from './core/manifest/index.js';
import { healthProbes } from './core/probe-plan.js';
import type { Lane } from './core/manifest/index.js';
import type { ScriptPlan } from './core/flag-map.js';
import type { Runtime, StackApi } from './stack-api.js';
import {
  buildRepoEnv,
  loadFlowsFrom,
  REPO_DEFAULT_DIR,
  repoContextFromFlags,
  repoOverridesFromFlags,
  resolveRepoRoot,
  resolveVendorScript,
  generateSlotFleetConfig,
} from './runtime/index.js';
import type {
  CoachWebFs,
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
  // M15: buildRepoEnv is the ONE flags→env-var overlay (DEV + the repo pins).
  return { ...env, ...buildRepoEnv(repoOverridesFromFlags(flags)) };
}

// ── runtime/context assembly (mirrors stack up's buildRuntime) ───────────────

/** The injected process/IO seams the StackApi runtime needs (from BaseCommand). */
export interface StackSeams {
  launcher: ServiceLauncher;
  meshExec: MeshExec;
  portProbe: PortProbe;
  dashFs: DashFs;
  /**
   * soa#300: the coach-web `.env.local` prelaunch fs seam — when coach-web is in the
   * closure, `up` writes `<coachWebRoot>/.env.local` so its browser boots against the
   * LOCAL mesh. Optional so callers that don't wire it stay byte-identical; the
   * command builds it from `getCoachWebFs()`.
   */
  coachWebFs?: CoachWebFs;
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
  prepWriteStamp?: (repoRoot: string) => void;
  prepRepairDeps?: (repoRoot: string) => boolean | Promise<boolean>;
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
  /**
   * `e2e run --tunnel`: the resolved `<moniker>.<VMS_BASE>` domain. When present the
   * runtime flips `tunnel:true`+`tunnelDomain`, which the facade already reads to
   * write dash `config.local.json`'s url-type localDefaults (`stack-api.ts` →
   * `syncDashLocalDefaults`); no facade change needed. Absent ⇒ `tunnel:false` (the
   * pre-tunnel default, byte-identical).
   */
  tunnelDomain?: string,
): { runtime: Runtime; repoRoots: Record<RepoKey, string> } {
  const ctx: ScriptContext = repoContextFromFlags(flags);

  const repoRoots = {} as Record<RepoKey, string>;
  for (const repo of Object.keys(REPO_DEFAULT_DIR) as RepoKey[]) {
    repoRoots[repo] = resolveRepoRoot(repo, ctx);
  }

  // rtsm-api's non-tunnel FLEET_CONFIG_PATH reads `${VENDOR_DIR}/rtsm-fleet-local.json`;
  // point VENDOR_DIR at the CLI's VENDORED copy (Phase-2 DECOUPLING), NOT tools/synthetic-dev.
  const vendorDir = dirname(resolveVendorScript('rtsm-fleet-local.json'));
  // soa#271: at slot > 0, generate a per-slot rtsm fleet (browser-visible endpoint =
  // the SLOT's rtsm host) and route it via RTSM_FLEET_PATH, so connect-web's browser
  // CRDT/realtime reaches THIS slot's rtsm, not slot 0's. `e2e run` assembles the
  // runtime HERE (not via BaseCommand.buildRuntime — the flagged duplication), so the
  // generation must be mirrored. Best-effort: a null keeps the vendored fleet.
  let rtsmFleetPath: string | undefined;
  if (profile.slot > 0) {
    const rtsmPort = profile.portOverrides['rtsm-api'];
    const stateDir = (flags['state-dir'] as string | undefined) ?? profile.stateDir;
    if (rtsmPort !== undefined) {
      rtsmFleetPath =
        generateSlotFleetConfig({
          localFleetPath: resolveVendorScript('rtsm-fleet-local.json'),
          outPath: `${stateDir}/rtsm-fleet-s${profile.slot}.json`,
          endpoint: `localhost:${rtsmPort}`,
        }) ?? undefined;
    }
  }
  // Thread the slot's port-override map + mesh offset (byte-identical base context
  // at slot 0 — `deriveInstance` guarantees slot-0 overrides resolve the defaults).
  const launchContext = defaultLaunchContext({
    repoRoots,
    vendorDir,
    portOverrides: profile.portOverrides,
    meshOffset: profile.meshOffset,
    pinoLevel: process.env.PINO_LOGGER_LEVEL,
    pinoIsExpressContext: process.env.PINO_LOGGER_ISEXPRESSCONTEXT,
    rtsmFleetPath,
    // --tunnel: thread the domain into the LAUNCH TOKENS, not just the Runtime.
    // Without this, tunnelOverlay() returns {} for every service THIS path
    // auto-launches, so `develop … --tunnel` silently brought services up with
    // pure-local browser env (VITE_*/PUBLIC_* = localhost) inlined into pages
    // served over the public tunnel origin (soa#322). Services already up are
    // still adopted untouched — this only fixes what develop itself launches.
    // lk creds / the generated rtsm fleet stay `stack up --tunnel` machinery.
    tunnel: tunnelDomain !== undefined ? { domain: tunnelDomain } : undefined,
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
    coachWebFs: seams.coachWebFs,
    prober: seams.prober,
    runner: seams.runner,
    // --tunnel (Phase 2): a resolved domain flips tunnel mode on so the facade writes
    // the dash config.local.json url-type localDefaults (up.sh sync_dash_local_defaults
    // parity). No domain ⇒ the pre-tunnel default (tunnel:false), byte-identical.
    tunnel: tunnelDomain !== undefined,
    tunnelDomain,
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
    prepWriteStamp: seams.prepWriteStamp,
    prepRepairDeps: seams.prepRepairDeps,
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
  // Scope the run to the terminal stage's own spec — else Playwright's testMatch
  // sweeps every spec in the SPA's e2e dir (found running coach-web/dashboard: it
  // also executed unrelated nav/timer specs). Gated to the single-spawn path only
  // (no `stage` override): `resolved.playwright.spec` is the TERMINAL stage's spec,
  // so pushing it during a bake/--from per-stage spawn (`stage.project` overridden
  // to a non-terminal project) would filter that stage's own project to a spec it
  // doesn't contain, running zero tests. Progressive flows' per-stage `project`s are
  // already testMatch-scoped to their own spec by the SPA's Playwright config, so
  // they don't need this — it's specifically for single-project SPAs like coach-web
  // where one `chromium` project matches every spec in the dir.
  if (!stage && resolved.playwright.spec) argv.push(resolved.playwright.spec);
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
 * offset), a slot-1 journey drives the SPA frontend on its offset port and hits
 * iam :4010 / scheduling :4008 / sessions :4007 / … instead of slot 0's base
 * ports. Keyed to the exact env vars `lane.ts` consumes today (nothing invented).
 *
 * `PLAYWRIGHT_BASE_URL` has no fixed `ServiceId` here — it must resolve to
 * WHICHEVER SPA's flow is running (`resolved.spa.system`), not always saga-dash.
 * `serviceUrlEnv`/`playwrightEnv` take that id as a param and default to
 * `'saga-dash'` only when the caller has no spa context (back-compat).
 */
export const PLAYWRIGHT_SERVICE_URL_ENV: Readonly<Record<string, ServiceId>> = Object.freeze({
  PLAYWRIGHT_IAM_URL: 'iam-api',
  PLAYWRIGHT_SIS_URL: 'sis-api',
  PLAYWRIGHT_PROGRAMS_URL: 'programs-api',
  PLAYWRIGHT_SCHEDULING_URL: 'scheduling-api',
  PLAYWRIGHT_SESSIONS_URL: 'sessions-api',
  PLAYWRIGHT_ADS_ADM_URL: 'ads-adm-api',
  PLAYWRIGHT_CONNECT_URL: 'connect-web',
  // soa#271 Phase B: the connect-api INGRESS base (telemetry producer, :6106) — distinct
  // from PLAYWRIGHT_CONNECT_URL (connect-web browser origin, :6210). Carries the slot
  // offset onto the ingress so a slotted telemetry-dosage run pings the SLOT's connect-api.
  // Consumed by saga-dash e2e/fixtures/lane.ts `CONNECT_API_URL`.
  PLAYWRIGHT_CONNECT_API_URL: 'connect-api',
});

/** `PLAYWRIGHT_BASE_URL`'s `ServiceId` when no SPA context is available (back-compat). */
const DEFAULT_BASE_URL_SERVICE: ServiceId = 'saga-dash';

/**
 * Build the stack-lane service-URL env from RESOLVED ports (each = manifest base +
 * slot offset). At slot 0 the ports are the base ports, so this yields the SAME
 * URLs `lane.ts` would default to (behaviour-identical); at slot N > 0 every URL
 * carries the `N * 1000` offset. Derived from `launchContext.ports` — never a
 * hardcoded port — so a re-banded/remapped service slots for free. A service with
 * no resolved port is omitted rather than emitting `localhost:undefined`.
 *
 * `baseUrlService` picks WHICH service backs `PLAYWRIGHT_BASE_URL` — the running
 * flow's own SPA frontend (`resolved.spa.system`), defaulting to saga-dash when
 * the caller has none.
 */
export function serviceUrlEnv(
  ports: Partial<Record<ServiceId, number>>,
  baseUrlService: ServiceId = DEFAULT_BASE_URL_SERVICE,
): Record<string, string> {
  const env: Record<string, string> = {};
  const basePort = ports[baseUrlService];
  if (basePort !== undefined) env.PLAYWRIGHT_BASE_URL = `http://localhost:${basePort}`;
  for (const [key, svc] of Object.entries(PLAYWRIGHT_SERVICE_URL_ENV)) {
    const port = ports[svc];
    if (port !== undefined) env[key] = `http://localhost:${port}`;
  }
  return env;
}

/**
 * The `ServiceId` → `tunnel.sh` HOSTNAME LABEL map for `e2e run --tunnel`. Under
 * `--tunnel` the Playwright browser is a REMOTE peer (opened on another box through
 * the vms rendezvous), so it can't reach `localhost:<port>` — every service URL must
 * become `https://<label>.<domain>` where `<label>` is the vendored tunnel.sh
 * SERVICES key (`vendor/tunnel.sh`, the frpc reverse-tunnel table).
 *
 * The label is NOT string-derivable from the ServiceId: `saga-dash→dash` /
 * `connect-web→connect` / `ads-adm-api→ads-adm` are renames; `iam-api`/`sis-api`/
 * `programs-api`/`scheduling-api`/`sessions-api` drop the `-api` suffix; but
 * `connect-api→connect-api` KEEPS it. So this is an explicit table keyed 1:1 to the
 * `PLAYWRIGHT_SERVICE_URL_ENV` ServiceIds (a drift guard test asserts every URL-env
 * ServiceId has an entry here and each label is a real tunnel.sh SERVICES entry).
 */
export const TUNNEL_SERVICE_LABELS: Readonly<Record<ServiceId, string>> = Object.freeze({
  'saga-dash': 'dash',
  'iam-api': 'iam',
  'sis-api': 'sis',
  'programs-api': 'programs',
  'scheduling-api': 'scheduling',
  'sessions-api': 'sessions',
  'ads-adm-api': 'ads-adm',
  'connect-web': 'connect',
  'connect-api': 'connect-api',
  // coach pair (vendored tunnel.sh: "coach:8800" / "coach-api:6105"). Without the
  // coach-web entry a tunnel coach flow keeps PLAYWRIGHT_BASE_URL=localhost:8800
  // while iam (AUTH_SESSIONCOOKIEDOMAIN=.<domain>) mints .<domain>-scoped SameSite
  // cookies — cross-site from a localhost page, so whoami never sees the session
  // and coach-web renders the soa#300 503 over an otherwise healthy tunnel.
  'coach-web': 'coach',
  'coach-api': 'coach-api',
} as Record<ServiceId, string>);

/**
 * A generous WAN timeout (ms) exported as `PLAYWRIGHT_TUNNEL_TIMEOUT_MS` when
 * `e2e run --tunnel` is active. The stack services still bind localhost (the prober
 * needs no bump), but the Playwright BROWSER hairpins over the WAN to
 * `https://<label>.<domain>` through the frps rendezvous box, so navigation/action
 * round-trips are far slower than a localhost run. 120s is a deliberately roomy
 * ceiling for that hop. CROSS-REPO: the value is CONSUMED in saga-dash's
 * `playwright.config.ts` (read into `use.navigationTimeout`/`actionTimeout`/`timeout`)
 * — NOT in this package — so the exact env name + ms budget must be confirmed there.
 */
export const TUNNEL_PLAYWRIGHT_TIMEOUT_MS = 120_000;

/**
 * The tunnel-mode variant of `serviceUrlEnv`: every `PLAYWRIGHT_*_URL` key becomes
 * `https://<label>.<domain>` (the frpc reverse-tunnel host) instead of
 * `http://localhost:<port>`. Used ONLY on the stack lane when `--tunnel` supplied a
 * `<moniker>.<VMS_BASE>` domain — a remote browser reaches the local stack through
 * the vms box. Keyed to the SAME env vars `lane.ts` consumes; the label per ServiceId
 * comes from `TUNNEL_SERVICE_LABELS`.
 */
export function tunnelServiceUrlEnv(
  domain: string,
  baseUrlService: ServiceId = DEFAULT_BASE_URL_SERVICE,
): Record<string, string> {
  const env: Record<string, string> = {};
  // `PLAYWRIGHT_BASE_URL` is NOT in `PLAYWRIGHT_SERVICE_URL_ENV` — it has no fixed
  // ServiceId (it follows the running flow's SPA). It must still be tunnelled: this
  // map-walk alone would leave a --tunnel run with NO baseURL, and the browser would
  // fall back to `localhost:8900` while every other URL is an https tunnel host —
  // silently defeating `e2e connect --tunnel` (soa#298), whose whole point is that a
  // REMOTE peer can reach the stack. Emit it explicitly from the flow's own SPA.
  const baseLabel = TUNNEL_SERVICE_LABELS[baseUrlService];
  if (baseLabel !== undefined) env.PLAYWRIGHT_BASE_URL = `https://${baseLabel}.${domain}`;
  for (const [key, svc] of Object.entries(PLAYWRIGHT_SERVICE_URL_ENV)) {
    const label = TUNNEL_SERVICE_LABELS[svc];
    if (label !== undefined) env[key] = `https://${label}.${domain}`;
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
 *
 * `PLAYWRIGHT_BASE_URL` is derived from `resolved.spa.system` — the flow's OWN
 * SPA frontend — not hardcoded to saga-dash, else a non-dash flow's Playwright
 * run navigates to saga-dash's port and 500s (found running coach-web's
 * `dashboard` flow: it opened `:8900`, saga-dash's port, instead of coach-web's).
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
  /**
   * Exploratory-review capture (`e2e run --capture`, docs/e2e-review.md):
   * inject `PLAYWRIGHT_CAPTURE=all`, the knob the SPA's stack config already
   * honours (per-action trace + video on EVERY test, not just retried
   * failures). Omitted (default) ⇒ the env is byte-identical to today.
   */
  capture?: boolean,
  /**
   * `e2e run --tunnel`: the resolved `<moniker>.<VMS_BASE>` tunnel domain. When
   * present (stack lane only), the `PLAYWRIGHT_*_URL` keys are re-pointed at the
   * frpc reverse-tunnel hosts (`https://<label>.<domain>`) so a REMOTE browser can
   * reach the local stack, and `PLAYWRIGHT_TUNNEL_TIMEOUT_MS` is exported for the
   * SPA's Playwright config to widen its WAN timeouts. Overlaid AFTER the
   * localhost/offset service URLs so tunnel always wins for those keys. Absent ⇒ the
   * env is byte-identical to today.
   */
  tunnelDomain?: string,
): Record<string, string> {
  // The date env (with `flow.env` merged LAST inside `computeEnv`) comes first, so
  // a flow's own env keeps winning for the occurrence-date clamp. Then, on the
  // stack lane, the slot-offset service URLs are overlaid AFTER — so the slot
  // offset ALWAYS wins for the PLAYWRIGHT_*_URL keys and a `flow.env` that pins a
  // service URL can never point slot > 0 back at slot 0's base port (same
  // split-brain class as the dash config.local.json offset). On a deployed lane
  // the service URLs are the lane's own hostnames (resolved in `lane.ts`), so we
  // do NOT inject/override them. Under --tunnel the tunnel HOSTS overlay LAST (over
  // the localhost URLs) so a remote browser hairpins through the vms box; --tunnel
  // is slot-0-only, so it never combines with the slot offset.
  const env: Record<string, string> = {
    ...computeEnv(resolved.flow, now),
    ...(dateOverrides ?? {}),
    ...(lane === 'stack' && ports ? serviceUrlEnv(ports, resolved.spa?.system) : {}),
    ...(lane === 'stack' && tunnelDomain ? tunnelServiceUrlEnv(tunnelDomain, resolved.spa?.system) : {}),
    ...(capture === true ? { PLAYWRIGHT_CAPTURE: 'all' } : {}),
    ...(tunnelDomain ? { PLAYWRIGHT_TUNNEL_TIMEOUT_MS: String(TUNNEL_PLAYWRIGHT_TIMEOUT_MS) } : {}),
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
  /** Plan 13: the raw `--to` token (echoed so the dry-run names the flag the user typed). Null when absent. */
  to: string | null;
  /** Plan 13: whether `--hold` was requested (post-run manual-testing handoff). */
  hold: boolean;
  /** M14: the checkpoint a --from run will restore (validated at run time, not here — pure). */
  checkpoint: { fixtureId: string; predecessor: string } | null;
  /** M14: the per-stage checkpoint fixtureIds a --snapshot-stages run bakes. */
  bakeCheckpoints: string[] | null;
  /** M14-C: the prerequisite's terminal checkpoint an eligible run restores OPPORTUNISTICALLY (availability is a run-time question). */
  prereqCheckpoint: { fixtureId: string; terminalStage: string } | null;
}

/** Options for the pure projection. */
export interface DescribeOptions {
  now: Date;
  lane: Lane;
  appCwd: string;
  passthrough: string[];
  skipReset: boolean;
  manifest?: Manifest;
  /** Plan 13: the raw `--to` token, echoed into the projection so the dry-run names the flag. */
  to?: string;
  /** Plan 13: whether `--hold` was requested (surfaced in the projection). */
  hold?: boolean;
  /** M14: project the per-stage bake fixtureIds (`--snapshot-stages` dry-run). */
  snapshotStages?: boolean;
  /**
   * M14-C: whether the opportunistic prerequisite restore is ELIGIBLE
   * (`--prereq-from-snapshot`, default true). The projection must not
   * advertise a restore the run's gates would never attempt.
   */
  prereqFromSnapshot?: boolean;
  /**
   * Resolved per-service stack ports (`launchContext.ports`, offset-carrying) —
   * threaded into the Playwright env so the dry-run shows the slot's OFFSET service
   * URLs. Absent (slot 0 caller may still pass the base map) ⇒ no service URLs.
   */
  ports?: Partial<Record<ServiceId, number>>;
  /**
   * Services excluded from THIS slot's closure (`profile.excludedServices`) — the
   * literal-port playback-trio backends that would collide with slot 0. Empty at slot 0.
   */
  excluded?: Set<ServiceId>;
  /** Exploratory-review capture (`--capture`) — surfaces PLAYWRIGHT_CAPTURE in the projected env. */
  capture?: boolean;
  /**
   * `e2e run --tunnel`: the resolved `<moniker>.<VMS_BASE>` domain — threaded into the
   * projected Playwright env so `--tunnel --dry-run` prints the `https://<label>.<domain>`
   * service URLs (+ `PLAYWRIGHT_TUNNEL_TIMEOUT_MS`) instead of the localhost ones.
   */
  tunnelDomain?: string;
}

/**
 * Additive seed (no reset): the flow's end-state was built by a PREREQUISITE
 * (so `reset` is false) yet it declares a `seed` whose steps must run ON TOP —
 * e.g. connect-content publishes its poll into content-api, which the journey
 * prerequisite never seeds. Deliberately EXCLUDES the checkpoint (`--from`) case:
 * there the restore IS the state source, so re-seeding would wipe the DBs the
 * restore just filled (a `--from` window never seeds). `--from` and a prerequisite
 * are mutually exclusive (resolve.ts), so keying on `prerequisite` alone is exact.
 * Also excluded under --skip-reset (the caller then wants pure state reuse).
 * The single source of truth for both the executor (§2c) and the --dry-run projection.
 */
export function isAdditiveSeed(resolved: ResolvedFlow, skipReset: boolean): boolean {
  const effectiveReset = resolved.reset && !skipReset;
  return !effectiveReset && !skipReset && !!resolved.seedSelection && !!resolved.prerequisite;
}

/**
 * Pure projection of a `ResolvedFlow` into the dry-run/JSON shape: the closure,
 * the effective seed plan (composed over the closure, only when this flow resets
 * + seeds), the exact Playwright argv + cwd, and the injected occurrence date.
 * Recurses the prerequisite. Touches NO seam, spawns nothing.
 */
export function describeResolved(resolved: ResolvedFlow, opts: DescribeOptions): ResolvedFlowDescription {
  // Computed ONCE; `env` below carries the same date keys (playwrightEnv wraps
  // computeEnv), so occurrenceDate reads from it instead of recomputing.
  const env = playwrightEnv(resolved, opts.now, opts.lane, opts.ports, undefined, opts.capture, opts.tunnelDomain);
  const effectiveReset = resolved.reset && !opts.skipReset;
  // Drop the slot's excluded services (literal-port playback-trio backends) from the
  // closure so the dry-run matches what a `--slot N` run actually brings up. Empty
  // set at slot 0 ⇒ the full closure, byte-identical.
  const excluded = opts.excluded ?? new Set<ServiceId>();
  const services = resolved.closure.services.filter((id) => !excluded.has(id));
  const seed =
    (effectiveReset || isAdditiveSeed(resolved, opts.skipReset)) && resolved.seedSelection
      ? (() => {
          const plan = composeSeedPlan(resolved.seedSelection, new Set(services), new Set<ServiceId>());
          return {
            // #221 multi-seed: labels carry any stamped dataset (shared printer).
            offline: plan.offline.map((s) => seedStepLabel(s)),
            online: plan.online.map((s) => seedStepLabel(s)),
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
      // Empty window (--to <first stage> / --from K --to K): no Playwright spawn.
      argv: resolved.stages.length > 0 ? playwrightArgv(resolved, opts.passthrough) : [],
    },
    to: opts.to ?? null,
    hold: opts.hold ?? false,
    occurrenceDate: env[ENV_OCCURRENCE_DATE] ?? '',
    env,
    // The prerequisite always builds the end-state headless + owns its own reset;
    // it gets no user passthrough.
    prerequisite: resolved.prerequisite
      ? describeResolved(resolved.prerequisite, {
          ...opts,
          passthrough: [],
          skipReset: false,
          // --to/--hold/--capture apply to the MAIN flow only, never the prerequisite build.
          to: undefined,
          hold: false,
          capture: undefined,
        })
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
    prereqCheckpoint: resolved.prerequisite &&
      opts.prereqFromSnapshot !== false &&
      opts.lane === 'stack' &&
      resolved.prerequisite.prerequisite === undefined
      ? {
          fixtureId: checkpointFixtureId(
            resolved.spa.id,
            resolved.prerequisite.flow.name,
            resolved.prerequisite.stages[resolved.prerequisite.stages.length - 1] as StageDefLike,
            resolved.prerequisite.stages.length,
          ),
          terminalStage: resolved.prerequisite.stages.at(-1)?.id ?? '',
        }
      : null,
  };
}

/** Structural alias for the stage arg `checkpointFixtureId` takes (pure projection use). */
type StageDefLike = ResolvedFlow['stages'][number];

// ── tunnel fail-loud (soa#327) ─────────────────────────────────────────────────

/**
 * The docs/tunnel.md concierge recipe, verbatim — the remediation every tunnel
 * fail-loud error embeds. Local state is rebuilt LOCALLY (fast, tested), then the
 * tunnel comes up and restores the snapshot; the alternative the gate prevents is
 * a silent full Playwright replay over the WAN, whose 30s polls starve and fail
 * far slower than this recipe runs.
 */
const TUNNEL_RECIPE_LINES: readonly string[] = [
  'Rebuild the state locally, then bring the tunnel up and restore it (docs/tunnel.md concierge):',
  '  ss stack down && ss stack up --seed full --reset',
  '  ss e2e run journey --through schedule',
  '  ss stack snapshot store --fixture-id tunnel-connect',
  '  ss stack down && ss stack up --tunnel --reset',
  '  ss stack snapshot restore tunnel-connect',
  '  ss develop connect --tunnel --student-login 1 --reuse',
  '',
  'Faster escape hatches when only the CHECKPOINT is the problem:',
  '  ss develop connect --refresh-snapshot   # re-bake the journey prerequisite fresh, then open the room',
  '  ss e2e run … --from-stale-ok            # accept an over-7-day checkpoint (e2e run only)',
];

/**
 * PURE builder for the fail-loud error a `--tunnel` run raises instead of the
 * local lane's silent warn+full-replay when the prerequisite checkpoint is
 * unusable (missing / stale / failed validation). The original violation is
 * embedded verbatim so the remediation is exact. Exported for unit tests.
 */
export function tunnelPrereqFallbackMessage(violation: string): string {
  return [
    '--tunnel: the prerequisite checkpoint is unusable, and a full replay over the tunnel is',
    'a trap (its WAN round-trips starve the specs’ 30s polls) — refusing to fall back silently.',
    '',
    violation.replace(/^/gm, '  '),
    '',
    ...TUNNEL_RECIPE_LINES,
  ].join('\n');
}

/**
 * PURE builder for the post-restore preflight's torn-checkpoint error (soa#327):
 * the restore SUCCEEDED but the flow's own persona cannot devLogin over the
 * tunnel — the baked state predates the roster work that creates the persona
 * (the walkthrough's alex.tutor 401). Remediation = the same re-bake recipe.
 */
export function tunnelTornCheckpointMessage(email: string, status: number): string {
  return [
    `--tunnel: the restored checkpoint looks TORN — devLogin for '${email}' returned ` +
      `${status === 0 ? 'no response' : `HTTP ${status}`} over the tunnel iam host, so the flow's ` +
      'personas cannot log in (their roster/pii state is missing from the baked dump).',
    '',
    ...TUNNEL_RECIPE_LINES,
  ].join('\n');
}

/**
 * PURE builder for the preflight's 403 verdict: devLogin is DISABLED on the iam
 * host — an iam-api/tunnel CONFIGURATION problem, so the re-bake recipe would be
 * a wild-goose chase and is deliberately NOT included.
 */
export function tunnelAuthMisconfigMessage(email: string, iamUrl: string): string {
  return [
    `--tunnel: devLogin for '${email}' returned HTTP 403 from ${iamUrl} — devLogin is disabled`,
    'there (AUTH_ENABLED is on, or the Origin is not allowlisted). This is an iam-api/tunnel',
    'configuration problem, NOT a stale checkpoint — re-baking will not help. Check the iam-api',
    'env this stack runs with (devLogin needs AUTH_ENABLED off in dev) and the tunnel host config.',
  ].join('\n');
}

/**
 * soa#327 post-restore preflight (tunnel only): one devLogin per flow-declared
 * settle persona against the tunnel iam host — the DIRECT probe that the
 * checkpoint just restored is usable by the very login the session will mint.
 * Callers gate on `deps.tunnelDomain !== undefined`; a flow with no declared
 * personas skips with a warning (nothing trustworthy to probe — the seed-alias
 * personas exist even in torn dumps).
 */
async function tunnelPersonaPreflight(flow: FlowDef, deps: ExecDeps): Promise<void> {
  const domain = deps.tunnelDomain as string;
  const personas = flow.settlePersonas ?? [];
  if (personas.length === 0) {
    deps.log(
      `⚠ tunnel preflight skipped: flow '${flow.name}' declares no settlePersonas — ` +
        'cannot verify the restored checkpoint is login-ready before the browsers launch',
    );
    return;
  }
  if (deps.preflight === undefined) {
    deps.log('⚠ tunnel preflight skipped: no devLogin prober wired (internal wiring gap)');
    return;
  }
  // The SAME host the remote browsers will use (tunnelServiceUrlEnv hands them
  // `https://<label>.<domain>`), so the probe exercises the room's exact path.
  const iamUrl = `https://${TUNNEL_SERVICE_LABELS['iam-api']}.${domain}`;
  for (const email of personas) {
    const status = await deps.preflight(buildDevLoginRequest(email, iamUrl));
    if (status === 200) {
      deps.log(`✓ tunnel preflight: devLogin 200 for ${email}`);
      continue;
    }
    if (status === 403) throw new FlowExecError(tunnelAuthMisconfigMessage(email, iamUrl));
    throw new FlowExecError(tunnelTornCheckpointMessage(email, status));
  }
}

// ── execution ─────────────────────────────────────────────────────────────────

// M15: FlowExecError + the M14 checkpoint restore/bake execution live in
// e2e-checkpoint-exec.ts; re-exported so run.ts/connect.ts imports are stable.
export { FlowExecError } from './e2e-checkpoint-exec.js';

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
   * `e2e run --tunnel`: the resolved `<moniker>.<VMS_BASE>` domain — threaded into the
   * Playwright child env so a REMOTE browser drives the `https://<label>.<domain>`
   * tunnel hosts (+ `PLAYWRIGHT_TUNNEL_TIMEOUT_MS`) instead of localhost. Slot-0-only
   * (guarded at the command). Rides the prerequisite recursion via `deps`.
   */
  tunnelDomain?: string;
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
  /**
   * Exploratory-review preservation hook (docs/e2e-review.md): called after
   * EVERY Playwright spawn that warrants preservation — every spawn of a
   * `--capture` run, and any RED spawn regardless (whatever artifacts exist:
   * retry traces, failure screenshots, error context). Playwright wipes
   * test-results/ at the next run's start, so this must fire per spawn (the
   * per-stage ladder and a prerequisite's replay each wipe the previous
   * spawn's artifacts). Rides down the prerequisite recursion via `deps`, so
   * a red prerequisite replay is preserved too. Absent ⇒ no preservation
   * (the second caller, `e2e connect`, never sets it).
   */
  preserveTraces?: (frame: {
    appCwd: string;
    spaId: string;
    flowName: string;
    stages: readonly { id: string; project: string }[];
  }) => void | Promise<void>;
  /**
   * soa#327 tunnel preflight: POST one devLogin (capped transport-class retries
   * inside the impl) and return the FINAL HTTP status. Consulted ONLY after a
   * successful checkpoint restore when `tunnelDomain` is set; absent ⇒ the
   * probe is skipped with a warning. Real impl: `makePersonaPreflight`
   * (runtime/settle-barrier.ts), wired by the command from its poster seam.
   */
  preflight?: PersonaPreflight;
  /**
   * soa#327 bake quiescence barrier: awaited at the TOP of `bakeStageCheckpoint`
   * (before any dump) when the flow declares `settlePersonas` and the bake
   * covers iam_pii_local — so a per-stage checkpoint is never dumped while the
   * roster-sync pipeline (outbox relay + the in-flight pii write window) still
   * has work in flight. Throws on timeout (a red bake beats a torn checkpoint).
   * Absent ⇒ no barrier (e.g. `e2e connect`, which never bakes). Real impl:
   * `makeSettleBarrier` (runtime/settle-barrier.ts), command-wired.
   */
  settleBarrier?: SettleBarrier;
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
  /**
   * M14-C: restore the prerequisite's terminal-stage checkpoint instead of the
   * full headless replay when a VALID one exists (fallback: replay). Default
   * true at the command layer (`--no-prereq-from-snapshot` opts out).
   */
  prereqFromSnapshot?: boolean;
  /**
   * Exploratory-review capture (`--capture`): inject `PLAYWRIGHT_CAPTURE=all`
   * into the Playwright child and preserve EVERY spawn's artifacts (not just
   * red ones). Kept in OPTIONS so the prerequisite recursion (which rebuilds
   * opts) never inherits it — a prerequisite is a build step, not the thing
   * under review; its red spawns are still preserved via the deps hook.
   */
  capture?: boolean;
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

  // Drop this slot's excluded services (literal-port playback-trio backends that would
  // collide with slot 0) from the closure BEFORE up/reset/seed/verify. Empty set at
  // slot 0 ⇒ the full closure, byte-identical.
  const excluded = deps.excluded ?? new Set<ServiceId>();
  const services = resolved.closure.services.filter((id) => !excluded.has(id));
  const slot = deps.slot ?? 0;

  // M14: the baked date env a --from (or prerequisite-checkpoint) restore
  // mandates for the Playwright child (§2.2 — restored data and running specs
  // must agree on the dates).
  let restoredDates: SnapshotFlowBlock['dates'] | undefined;

  // 0. Prerequisite first (e.g. connect-session ⇐ journey through 'schedule').
  // M14-C: OPPORTUNISTICALLY restore the prerequisite's terminal-stage
  // checkpoint instead of the full headless replay — falling back to the
  // replay when the checkpoint is absent/invalid (unlike --from, which
  // hard-errors: the prerequisite path always has the replay as its source of
  // truth). Runs in THIS frame so the checkpoint's baked dates reach THIS
  // flow's Playwright env (they cannot cross the recursion boundary).
  if (resolved.prerequisite) {
    const prereq = resolved.prerequisite;
    let restored = false;
    // NESTED chains (A ⇐ B ⇐ C) always REPLAY: restoring B's checkpoint would
    // skip C's rebuild entirely (B's bake never dumped C-only DBs and the
    // coverage guard sees only B's closure) — conservative until checkpoints
    // learn transitive coverage.
    if (
      opts.prereqFromSnapshot !== false &&
      opts.lane === 'stack' &&
      deps.checkpoints !== undefined &&
      prereq.prerequisite === undefined
    ) {
      // The prerequisite's stages ARE the full producing prefix (1..through).
      const prereqWithCheckpoint: ResolvedFlow = {
        ...prereq,
        checkpoint: {
          predecessor: prereq.stages[prereq.stages.length - 1] as ResolvedFlow['stages'][number],
          predecessorPosition: prereq.stages.length,
          producingStages: prereq.stages,
        },
      };
      const prereqServices = prereq.closure.services.filter((id) => !excluded.has(id));
      try {
        // Union bring-up BEFORE the restore: the replay path leaves the
        // prerequisite's services running, and provision/migrate only cover the
        // up() set — a prereq-closure DB dump must land in a provisioned DB.
        const union = [...new Set<ServiceId>([...prereqServices, ...services])];
        deps.log(`==> up: ${union.length} service(s) [${union.join(', ')}] (prerequisite union)`);
        const up = await deps.api.up(union);
        if (!up.ok) {
          throw new FlowExecError(`native bring-up failed${up.failedAt ? ` at ${up.failedAt}` : ''}`);
        }
        restoredDates = await restoreCheckpoint(prereqWithCheckpoint, deps, opts, prereqServices, m);
        deps.log(
          `==> prerequisite: ${prereq.flow.name}@${prereq.stages.at(-1)?.id} restored from checkpoint (replay skipped)`,
        );
        restored = true;
      } catch (err) {
        if (!(err instanceof FlowExecError)) throw err;
        // A failed BRING-UP would fail the replay too — don't retry it.
        if (err.message.includes('bring-up failed')) throw err;
        // soa#327 fail-loud: under --tunnel the silent full replay is a TRAP, not a
        // fallback — the remote browser's WAN round-trips starve the specs' 30s
        // polls, so the replay fails slower than the local re-bake recipe runs.
        // Local lane (tunnelDomain undefined) keeps the warn+replay byte-identical.
        if (deps.tunnelDomain !== undefined) {
          throw new FlowExecError(tunnelPrereqFallbackMessage(err.message));
        }
        deps.log(`⚠ prerequisite checkpoint unavailable — falling back to full replay:\n${err.message}`);
      }
      // soa#327 preflight: the restore SUCCEEDED, but under --tunnel that is not
      // enough — probe that the prerequisite flow's own personas can devLogin
      // over the tunnel iam host BEFORE any browser launches. A torn checkpoint
      // (the walkthrough's alex.tutor 401) fails loud here with the re-bake
      // recipe instead of minting a session that 401s minutes later.
      if (restored && deps.tunnelDomain !== undefined) {
        await tunnelPersonaPreflight(prereq.flow, deps);
      }
    }
    if (!restored) {
      deps.log(`==> prerequisite: ${prereq.flow.name} (through '${prereq.stages.at(-1)?.id}', headless)`);
      const preCode = await executeResolvedFlow(prereq, deps, {
        lane: opts.lane,
        skipReset: false,
        passthrough: [],
        // The opt-out contract holds transitively: --no-prereq-from-snapshot
        // forces the replay for NESTED prerequisites too (deps.checkpoints
        // rides down unchanged, so the gate alone must carry the choice).
        prereqFromSnapshot: opts.prereqFromSnapshot,
      });
      if (preCode !== 0) {
        throw new FlowExecError(`prerequisite flow '${prereq.flow.name}' failed (exit ${preCode})`);
      }
    }
  }
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

    // #221 coach-deferral (d): honour `up`'s repo-absent skips downstream — the
    // same seed-active-set pattern `stack up` uses. A skipped service (repo not
    // cloned, or a hard dependent of one) must not be SEEDED (its steps would
    // spawn-crash on the missing checkout dir) nor VERIFIED (probing a service
    // that was never launched would redden the run the skip guard tried to keep
    // green). Its steps degrade to `service-inactive` skip notes instead.
    const upSkipped = new Set(up.skipped.map((s) => s.id));
    const activeServices = services.filter((id) => !upSkipped.has(id));
    for (const s of up.skipped) deps.log(`⚠ ${s.message}`);

    // 2a. M14 --from: restore the predecessor stage's checkpoint — the state
    // source replacing the reset+seed AND the Playwright replay of stages
    // 1..from-1. Gated on resolved.checkpoint (never on effectiveReset:
    // resolved.reset is already false for a --from window by construction).
    if (resolved.checkpoint) {
      restoredDates = await restoreCheckpoint(resolved, deps, opts, services, m);
      // soa#327 preflight (the --from twin of the prerequisite site above): a
      // restored mid-flow checkpoint under --tunnel must be login-ready for the
      // flow's own personas before Playwright spawns.
      if (deps.tunnelDomain !== undefined) {
        await tunnelPersonaPreflight(resolved.flow, deps);
      }
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
        const plan = composeSeedPlan(resolved.seedSelection, new Set(activeServices), new Set<ServiceId>());
        const seeded = await deps.api.seed(plan);
        if (!seeded.ok) throw new FlowExecError(`seed failed at ${seeded.failed}`);
      }
    } else if (resolved.seedSelection && isAdditiveSeed(resolved, opts.skipReset)) {
      // 2c. Additive seed (no reset): run the flow's declared seed ON TOP of the
      // prerequisite-built state — e.g. connect-content publishes its legacy poll
      // into content-api, which the journey prerequisite never seeds (content-api
      // isn't in journey's closure). Flow authors MUST scope such a seed (`only` /
      // `perSystem`, as connect-content does with only:['content-api']) so it can't
      // clobber the prerequisite-built state.
      deps.log('==> additive seed (no reset)');
      const plan = composeSeedPlan(resolved.seedSelection, new Set(activeServices), new Set<ServiceId>());
      const seeded = await deps.api.seed(plan);
      if (!seeded.ok) throw new FlowExecError(`additive seed failed at ${seeded.failed}`);
    } else if (!resolved.checkpoint) {
      deps.log('==> skip reset/seed (reuse current stack state)');
    }

    // 3. verify (tolerate the SPA's own frontend service being red — branch posture / dev server).
    // deps.ports (launchContext.ports, offset-carrying) is REQUIRED here: without it
    // the probes hit the manifest BASE ports, i.e. slot 0's services — a slot-N
    // verify would false-PASS off a healthy slot-0 stack (cross-slot masking) and
    // false-FAIL when slot 0's counterpart is down even though the slot's own
    // service is green (observed: slot-2 ads-adm-api healthy on :7005, verify
    // probing :5005). At slot 0 `ports` equals the base ports — byte-identical.
    // activeServices (not services): up()-skipped repo-absent services must not
    // be probed either (coach-deferral, #241) — the two fixes compose.
    const probes = healthProbes(m, activeServices, deps.ports);
    const verified = await deps.api.verify(probes, { tolerate: [resolved.spa.system] });
    if (!verified.passed) {
      const down = verified.rows.filter((r) => !r.ok && !r.tolerated).map((r) => r.id);
      throw new FlowExecError(`verify failed — unhealthy: ${down.join(', ')}`);
    }
  } else {
    deps.log(`==> ${opts.lane} lane: no local stack to bring up; running Playwright against the deployed composition`);
  }

  // Plan 13 EMPTY window (--to <first stage>, or --from K --to K): the stack is now
  // in the target stage's entry posture — a reset+seed baseline, or the predecessor
  // checkpoint restored above. There is NO stage to drive, so skip Playwright and
  // return green; the command's --hold epilogue (if any) mints the jar + opens the
  // browser after this returns.
  if (resolved.stages.length === 0) {
    deps.log("==> no stages to run — window is empty (stack left at the target stage's entry state)");
    return 0;
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
  const env = playwrightEnv(resolved, deps.now, opts.lane, deps.ports, dateOverrides, opts.capture, deps.tunnelDomain);

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

  // Exploratory-review preservation (docs/e2e-review.md): after EVERY spawn a
  // --capture run made, and after any RED spawn regardless (the failure
  // artifacts Playwright would wipe at the next run's start). Must run per
  // spawn — the per-stage ladder and any later spawn wipe test-results/.
  const preserveAfter = async (code: number): Promise<void> => {
    if (deps.preserveTraces === undefined) return;
    if (opts.capture !== true && code === 0) return;
    await deps.preserveTraces({
      appCwd: deps.appCwd,
      spaId: resolved.spa.id,
      flowName: resolved.flow.name,
      stages: resolved.stages.map((s) => ({ id: s.id, project: s.project })),
    });
  };

  // Default path: ONE spawn with the terminal project — Playwright's config-side
  // dependency chain replays 1..N (byte-identical to pre-M14). The per-stage
  // ladder exists ONLY for M14: baking needs a checkpoint between stages, and a
  // --from window must NOT let the dependency chain replay the restored prefix.
  const perStage = opts.snapshotStages === true || resolved.checkpoint !== undefined;
  if (!perStage) {
    const code = await spawn();
    await preserveAfter(code);
    return code;
  }

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
    await preserveAfter(code);
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

