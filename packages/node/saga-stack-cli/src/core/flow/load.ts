/**
 * `flows.json` loader (plan §5.1 + §5.3, saga-ed/soa#214).
 *
 * `flows.json` is THE one external contract authored by SPA repos, and the ONE
 * place the CLI parses JSON with zod (the service manifest itself stays a frozen
 * TS module). This module splits that into two layers so `core/**` stays pure:
 *
 *  - `parseFlowManifest(text, sourcePath?)` — PURE: `JSON.parse` + zod validate
 *    of an in-memory string. No IO, deterministic; used by tests and by any
 *    caller that already holds the document text.
 *  - `loadFlowManifest(filePath, readText?)` — the thin reading loader used by
 *    discovery. The fs read is an INJECTABLE seam (`readText`) that defaults to
 *    `node:fs.readFileSync`, so the only impurity is the default reader; tests
 *    pass a fake reader and never touch disk. (Mirrors the seam pattern the rest
 *    of the CLI uses to keep planning pure and IO behind an injected boundary.)
 *
 * Both throw a single, message-rich `Error` on a bad path / malformed JSON /
 * schema violation, with `sourcePath` woven in so a misauthored SPA `flows.json`
 * points the author straight at the offending file + field.
 */

import { readFileSync } from 'node:fs';
import { flowManifestSchema } from './types.js';
import type { FlowManifest } from './types.js';

/** Flatten a zod error into one `path: message` line per issue. */
function formatIssues(error: import('zod').ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

/** Tag a source location onto a message when we know which file it came from. */
function at(sourcePath?: string): string {
  return sourcePath ? ` (${sourcePath})` : '';
}

/**
 * Parse + zod-validate a `flows.json` document already in memory. PURE: no IO.
 * Throws on malformed JSON or any schema violation, listing every zod issue.
 */
export function parseFlowManifest(text: string, sourcePath?: string): FlowManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`flows.json is not valid JSON${at(sourcePath)}: ${detail}`);
  }

  const result = flowManifestSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`flows.json failed schema validation${at(sourcePath)}:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Injectable text reader — the single IO seam of the loading layer. */
export type ReadTextFile = (filePath: string) => string;

/** Default reader: synchronous UTF-8 fs read (the only impurity in this module). */
const defaultReadTextFile: ReadTextFile = (filePath) => readFileSync(filePath, 'utf8');

/**
 * Read + validate a `flows.json` from disk into a typed `FlowManifest`.
 *
 * `readText` defaults to `node:fs.readFileSync` (the normal runtime path used by
 * discovery); inject a fake in tests to validate parsing without disk IO. Throws
 * a message-rich `Error` if the file can't be read or fails validation.
 */
export function loadFlowManifest(filePath: string, readText: ReadTextFile = defaultReadTextFile): FlowManifest {
  let text: string;
  try {
    text = readText(filePath);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`flows.json could not be read at ${filePath}: ${detail}`);
  }
  return parseFlowManifest(text, filePath);
}
