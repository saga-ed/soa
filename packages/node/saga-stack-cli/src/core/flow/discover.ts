/**
 * Flow discovery — PURE path resolution (plan §5.3, saga-ed/soa#214).
 *
 * Computes WHERE a SPA's `flows.json` should live, mirroring up.sh's repo-path
 * env vars: `repoRoot = $<repoEnvVar> ?? join($DEV, defaultRepoSubpath)` (and
 * `$DEV` itself defaults to `$HOME/dev`), then `join(repoRoot, e2eDir,
 * 'flows.json')`. Extra ad-hoc locations come from `$SAGA_E2E_SPA_PATHS` (a
 * delimiter-list of dirs OR files) and the `--spa-path` override, which take
 * precedence so a worktree / clean-checkout can point the CLI at a specific file.
 *
 * This module is PURE: it only produces an ORDERED list of candidate paths. The
 * fs existence-check + JSON read + zod parse is a thin runtime helper
 * (`runtime/flows.ts`), which TOLERATES a missing file (returns "not found,
 * author it") rather than crashing — the SPA simply has not authored flows yet.
 *
 * PURE: zero IO, no `process.env` access (the caller passes an env bag).
 */

import type { SpaDescriptor } from './types.js';

/** A `process.env`-shaped lookup the caller passes in (keeps this module pure). */
export type EnvLookup = Record<string, string | undefined>;

/** A parsed `<spa>/<flow>` reference. `spaId` is absent when the arg had no slash. */
export interface FlowRef {
  spaId?: string;
  flowName: string;
}

/**
 * Parse a flow reference. `'saga-dash/journey'` → `{ spaId:'saga-dash',
 * flowName:'journey' }`; `'journey'` (no slash) → `{ flowName:'journey' }` so the
 * command layer can apply a default SPA. Only the FIRST slash splits (flow names
 * have no slashes today, but this is the robust split).
 */
export function parseFlowRef(ref: string): FlowRef {
  const i = ref.indexOf('/');
  if (i < 0) return { flowName: ref };
  return { spaId: ref.slice(0, i), flowName: ref.slice(i + 1) };
}

/** Join a root + subpath without depending on leading/trailing-slash shape. */
function joinPath(root: string, sub: string): string {
  return `${root.replace(/\/+$/, '')}/${sub.replace(/^\/+/, '')}`;
}

/** A non-empty, non-whitespace env value, else undefined. */
function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() ? v : undefined;
}

/**
 * Resolve a SPA's repo root from the env, mirroring up.sh:
 * `$<repoEnvVar>` wins; else `$DEV/<defaultRepoSubpath>`; `$DEV` itself defaults
 * to `$HOME/dev`.
 */
export function resolveRepoRoot(spa: SpaDescriptor, env: EnvLookup): string {
  const override = nonEmpty(env[spa.repoEnvVar]);
  if (override) return override.replace(/\/+$/, '');
  const dev = nonEmpty(env.DEV) ?? joinPath(nonEmpty(env.HOME) ?? '', 'dev');
  return joinPath(dev, spa.defaultRepoSubpath);
}

/** The registry-resolved `flows.json` path for a SPA under a given repo root. */
export function flowsJsonPath(spa: SpaDescriptor, repoRoot: string): string {
  return joinPath(joinPath(repoRoot, spa.e2eDir), 'flows.json');
}

/**
 * Split a `$SAGA_E2E_SPA_PATHS` value into entries. Accepts `:`-separated (unix
 * PATH style) values; empty segments are dropped. Each entry is a dir OR a file
 * (see `normalizeCandidate`).
 */
export function splitSpaPaths(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Treat a candidate as a `flows.json` file as-is, or as a dir to append to. */
function normalizeCandidate(p: string): string {
  return /(^|\/)flows\.json$/.test(p) ? p : joinPath(p, 'flows.json');
}

/** Inputs for computing the ordered candidate paths to probe for a SPA. */
export interface DiscoverInput {
  /** The SPA descriptor (from the registry). */
  spa: SpaDescriptor;
  /** A `process.env`-shaped bag (for `$<repoEnvVar>` / `$DEV` / `$HOME`). */
  env: EnvLookup;
  /**
   * Extra ad-hoc locations, HIGHEST priority first. The command layer builds this
   * from `--spa-path` (first) then `splitSpaPaths($SAGA_E2E_SPA_PATHS)`. Each may
   * be a `flows.json` file or a dir containing one.
   */
  extraPaths?: string[];
}

/**
 * The ordered, de-duplicated list of `flows.json` paths to probe for a SPA:
 * explicit overrides (`--spa-path`, then `$SAGA_E2E_SPA_PATHS`) FIRST, then the
 * registry-resolved repo path. The runtime helper walks this list in order and
 * loads the first that exists.
 */
export function flowsCandidatePaths(input: DiscoverInput): string[] {
  const out: string[] = [];
  for (const p of input.extraPaths ?? []) out.push(normalizeCandidate(p));
  out.push(flowsJsonPath(input.spa, resolveRepoRoot(input.spa, input.env)));

  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}
