/**
 * `resolveFlow` — the PURE flow resolver (plan §5.2 / §5.4, saga-ed/soa#214).
 *
 * Given a parsed+validated `FlowManifest` (a loaded `flows.json`), a flow name,
 * and resolve options, produce a `ResolvedFlow`: everything the M5 runner needs
 * to drive `StackApi.up/reset/seed/verify` + Playwright IN-PROCESS, with NO IO.
 *
 * The resolver:
 *  1. looks up the named flow (throws a helpful error on a miss, listing names);
 *  2. validates the requested `lane` is one the flow declares;
 *  3. selects stages — progressive flows take `stages[0..idx]` (the Playwright
 *     `dependencies` chain then runs 1..N), non-progressive flows take the single
 *     `--through`-matched stage (default: the terminal stage);
 *  4. unions the selected stages' `requiredSystems` ∪ `{ spa.system, iam-api }`
 *     and feeds that to `computeClosure` (the N-of-M engine) — so a journey run
 *     "through pods" never launches content-api, a real partial-stack saving;
 *  5. merges the terminal stage's seed over the flow seed (per-system selection);
 *  6. recurses `prerequisite` (e.g. connect-session ⇐ journey through 'schedule'),
 *     forcing it HEADLESS and letting it own the reset+seed so the main flow runs
 *     SKIP_RESET (matching connect-session.sh).
 *
 * PURE: zero IO, NO `new Date()` — the weekday-clamp env (`computeEnv`) is a
 * separate pure core function the runtime feeds a reference date. This module
 * only shapes the orchestration inputs.
 */

import { computeClosure } from '../closure.js';
import type { Closure } from '../closure.js';
import { getService, manifest as defaultManifest } from '../manifest/index.js';
import type { Lane, Manifest, ServiceId } from '../manifest/index.js';
import type { SeedSelection } from '../seed/index.js';
import type { FlowDef, FlowManifest, SpaDescriptor, StageDef } from './types.js';

/** The Playwright invocation the runner spawns (the CLI never parses the SPA's config). */
export interface ResolvedPlaywright {
  /** `spa.playwrightConfig`, passed verbatim via `--config` (repo-relative to `appDir`). */
  config: string;
  /** The TERMINAL stage's Playwright `project`; deps chain 1..N (matches check-e2e.sh). */
  project: string;
  /** Playwright `--grep-invert` tag for pipeline runs (e.g. `@interactive`); omitted when the run IS the tagged stage. */
  grepInvert?: string;
  /** Run headed (foreground flows default headed; `--headless` flips it). */
  headed: boolean;
}

/**
 * A flow resolved into the inputs the runner needs (surfaced by `--dry-run`).
 * Planning only — no process/fs/network has been touched to build it.
 */
export interface ResolvedFlow {
  /** The SPA that owns this `flows.json`. */
  spa: SpaDescriptor;
  /** The resolved flow definition. */
  flow: FlowDef;
  /** Stages selected for this run (after `throughPhase` / `onlyStages`). */
  stages: StageDef[];
  /** Union of selected stages' `requiredSystems` ∪ `{ spa.system, iam-api }` (pre-closure). */
  requiredSystems: ServiceId[];
  /** The full dependency closure of `requiredSystems` (the N-of-M launch set). */
  closure: Closure;
  /** Effective seed selection (flow-level, terminal-stage seed merged over it). */
  seedSelection?: SeedSelection;
  /** Whether THIS flow's run should reset+seed before Playwright. False when a prerequisite already built the end-state. */
  reset: boolean;
  /** Foreground hold (window/AV) rather than headless-by-default. */
  foreground: boolean;
  /** The Playwright invocation. */
  playwright: ResolvedPlaywright;
  /** Recursively-resolved prerequisite flow (built headless, owns the reset+seed). */
  prerequisite?: ResolvedFlow;
  /** Flow-level extra env injected for every stage (from `flows.json` `flow.env`). */
  env?: Record<string, string>;
}

/** Options narrowing which stages of a flow to resolve. */
export interface ResolveFlowOptions {
  /** Resolve THROUGH this phase — matched against a stage's `id`, `phase`, or `project`. */
  throughPhase?: string | number;
  /** Lane the run targets; validated against `flow.lanes`. Default `'stack'`. */
  lane?: Lane;
  /** Run only these stage ids (STAGE_ONLY iteration); overrides `throughPhase`. */
  onlyStages?: string[];
  /** Force headed/headless explicitly (else foreground flows default headed). */
  headed?: boolean;
  /** Keep `optional:true` playback services in the closure (else auto-detected). */
  withPlayback?: boolean;
  /** Service manifest the closure is computed against (defaults to the frozen one). */
  serviceManifest?: Manifest;
  /** Internal: flow names already on the prerequisite chain (cycle guard). */
  visited?: string[];
}

/** Match a `--through` token against a stage's id, phase label, or Playwright project. */
function stageMatches(stage: StageDef, token: string | number): boolean {
  const t = String(token);
  return stage.id === t || stage.project === t || (stage.phase !== undefined && String(stage.phase) === t);
}

/** Select the stages to run for this flow + options. */
function selectStages(flow: FlowDef, opts: ResolveFlowOptions): StageDef[] {
  const { stages } = flow;

  // STAGE_ONLY: an explicit subset (by id / project / phase), in flow order.
  if (opts.onlyStages && opts.onlyStages.length > 0) {
    const want = new Set(opts.onlyStages);
    const sel = stages.filter((s) => want.has(s.id) || want.has(s.project));
    if (sel.length === 0) {
      throw new Error(
        `flow '${flow.name}': no stages match onlyStages [${opts.onlyStages.join(', ')}] (have: ${stages
          .map((s) => s.id)
          .join(', ')})`,
      );
    }
    return sel;
  }

  // --through <phase>: progressive ⇒ 1..idx; non-progressive ⇒ the single match.
  if (opts.throughPhase !== undefined) {
    const idx = stages.findIndex((s) => stageMatches(s, opts.throughPhase as string | number));
    if (idx < 0) {
      throw new Error(
        `flow '${flow.name}': no stage matches --through '${opts.throughPhase}' (have: ${stages
          .map((s) => (s.phase !== undefined ? `${s.phase}:${s.id}` : s.id))
          .join(', ')})`,
      );
    }
    return flow.progressive ? stages.slice(0, idx + 1) : [stages[idx] as StageDef];
  }

  // Default: progressive ⇒ all stages (terminal = last); non-progressive ⇒ the last stage.
  return flow.progressive ? stages.slice() : [stages[stages.length - 1] as StageDef];
}

/** Dedup-preserving union of the selected stages' requiredSystems ∪ {spa.system, iam-api}. */
function unionRequiredSystems(stages: StageDef[], spa: SpaDescriptor): ServiceId[] {
  const seen = new Set<ServiceId>();
  const out: ServiceId[] = [];
  const add = (id: ServiceId): void => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const stage of stages) for (const id of stage.requiredSystems) add(id);
  add(spa.system);
  add('iam-api');
  return out;
}

/** Merge the terminal stage's seed over the flow seed (per-system override wins). */
function effectiveSeed(flow: FlowDef, terminal: StageDef): SeedSelection | undefined {
  const base = flow.seed;
  const override = terminal.seed;
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) } as SeedSelection;
}

/**
 * Resolve a named flow from a loaded `FlowManifest` into a `ResolvedFlow`.
 * Throws on an unknown flow, an unsupported lane, an unmatched `--through`, or a
 * prerequisite cycle.
 */
export function resolveFlow(
  manifest: FlowManifest,
  flowName: string,
  opts: ResolveFlowOptions = {},
): ResolvedFlow {
  const sm = opts.serviceManifest ?? defaultManifest;
  const lane: Lane = opts.lane ?? 'stack';

  const flow = manifest.flows.find((f) => f.name === flowName);
  if (!flow) {
    throw new Error(
      `unknown flow '${flowName}' in ${manifest.spa.id}/flows.json (have: ${manifest.flows
        .map((f) => f.name)
        .join(', ')})`,
    );
  }
  if (!flow.lanes.includes(lane)) {
    throw new Error(
      `flow '${flowName}' does not support lane '${lane}' (supports: ${flow.lanes.join(', ')})`,
    );
  }

  const stages = selectStages(flow, opts);
  // selectStages always returns ≥1 stage (schema enforces ≥1; selection keeps ≥1).
  const terminal = stages[stages.length - 1] as StageDef;

  const requiredSystems = unionRequiredSystems(stages, manifest.spa);
  const seedSelection = effectiveSeed(flow, terminal);

  // Admit playback services into the closure iff a selected stage requires one
  // (optional in the manifest) or the seed layers the playback add-on.
  const requiresOptional = requiredSystems.some((id) => getService(id, sm).optional);
  const withPlayback =
    opts.withPlayback ?? (requiresOptional || (seedSelection?.addOns?.includes('playback') ?? false));
  // followBrowserEdges:false — a flow's requiredSystems explicitly list the
  // backends its stages touch; we must NOT auto-expand the SPA's browser deps
  // (which would drag in every backend and defeat the N-of-M payoff, §5.2).
  const closure = computeClosure(sm, requiredSystems, {
    withPlayback,
    followBrowserEdges: false,
  });

  // Prerequisite recursion (e.g. connect-session ⇐ journey through 'schedule').
  const visited = opts.visited ?? [];
  let prerequisite: ResolvedFlow | undefined;
  if (flow.prerequisite) {
    if (visited.includes(flow.prerequisite.flow)) {
      throw new Error(
        `prerequisite cycle: ${[...visited, flowName, flow.prerequisite.flow].join(' → ')}`,
      );
    }
    prerequisite = resolveFlow(manifest, flow.prerequisite.flow, {
      throughPhase: flow.prerequisite.throughStage,
      lane,
      headed: false, // the prerequisite builds the end-state headless (connect-session.sh)
      withPlayback,
      serviceManifest: sm,
      visited: [...visited, flowName],
    });
  }

  // If a prerequisite builds the end-state, the main flow runs SKIP_RESET; else
  // it resets+seeds itself when its seed asks for it.
  const reset = prerequisite ? false : (seedSelection?.reset ?? false);
  const foreground = flow.foreground ?? false;
  const headed = opts.headed ?? foreground;

  // Pipeline runs default-exclude @interactive (run-stack-e2e.sh); a run whose
  // terminal stage IS the tagged stage selects it explicitly, so don't invert.
  const terminalTagged = (terminal.tags ?? []).includes('@interactive');
  const grepInvert = terminalTagged ? undefined : '@interactive';

  return {
    spa: manifest.spa,
    flow,
    stages,
    requiredSystems,
    closure,
    seedSelection,
    reset,
    foreground,
    playwright: {
      config: manifest.spa.playwrightConfig,
      project: terminal.project,
      grepInvert,
      headed,
    },
    prerequisite,
    env: flow.env,
  };
}
