/**
 * Flow-manifest IO — the thin runtime helper behind PURE flow discovery
 * (plan §5.3, saga-ed/soa#214).
 *
 * `core/flow/discover.ts` computes an ORDERED list of candidate `flows.json`
 * paths (pure). This helper is the ONE place that touches the fs for flows: it
 * walks those candidates, reads + JSON-parses + zod-validates the first that
 * exists, and TOLERATES a total miss (returns `{ found:false }` with a
 * "author it" message) rather than crashing — a SPA may simply not have authored
 * flows yet. A file that exists but is malformed (bad JSON / fails the zod
 * schema) is a real authoring error and is surfaced by throwing.
 *
 * IO seam: `core/**` must never import this; the command layer composes
 * `flowsCandidatePaths` (core) → `loadFlowsFrom` (here).
 */

import { existsSync, readFileSync } from 'node:fs';
import { flowManifestSchema } from '../core/flow/index.js';
import type { FlowManifest } from '../core/flow/index.js';

/** The outcome of probing a candidate list for a `flows.json`. */
export type LoadFlowsResult =
  | { found: true; path: string; manifest: FlowManifest }
  | { found: false; tried: string[]; message: string };

/**
 * Read the first existing `flows.json` from `candidates`, validating it against
 * the zod `flowManifestSchema`. Returns `{ found:false }` (NOT a throw) when no
 * candidate exists. Throws on invalid JSON or a schema failure in a file that
 * DOES exist (a real authoring bug worth surfacing loudly).
 */
export function loadFlowsFrom(candidates: string[]): LoadFlowsResult {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`flows.json at ${path} is not valid JSON: ${(err as Error).message}`);
    }
    // zod throws a descriptive ZodError on a schema violation — let it propagate.
    const manifest = flowManifestSchema.parse(raw);
    return { found: true, path, manifest };
  }
  return {
    found: false,
    tried: candidates,
    message:
      candidates.length > 0
        ? `no flows.json found (tried: ${candidates.join(', ')}). Author one for this SPA — ` +
          `see examples/flows/saga-dash.flows.json in @saga-ed/saga-stack-cli for the template.`
        : 'no flows.json candidate paths were computed (unknown SPA and no --spa-path / $SAGA_E2E_SPA_PATHS).',
  };
}
