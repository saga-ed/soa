/**
 * Deterministic canonicalizer for `oclif.manifest.json` (soa#353).
 *
 * `oclif manifest` emits the `commands` map (and its nested objects) in
 * filesystem discovery order, which is not stable across machines or fresh
 * checkouts. Because this package COMMITS the manifest — it is listed in
 * package.json `files` and ships in the published tarball so the installed CLI
 * can load commands/help without scanning the filesystem — that instability
 * shows up as a large key-reordering diff on every `pnpm build`, even when no
 * command actually changed. Running the manifest through a recursive key sort
 * after `oclif manifest` makes the on-disk bytes a pure function of the command
 * set: a no-op build produces a no-op diff.
 *
 * Array order is preserved — it can be semantically meaningful (e.g. the order
 * of `examples`) — so only object keys are reordered.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Recursively sort object keys; leave arrays and primitives in place. */
export function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    // Compare by UTF-16 code unit (same order as Array.prototype.sort's default)
    // rather than localeCompare, which is locale-dependent and non-portable.
    for (const [key, val] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      sorted[key] = sortKeysDeep(val);
    }
    return sorted;
  }
  return value;
}

/**
 * Parse a raw `oclif.manifest.json` string and re-serialize it with keys sorted
 * deeply, 2-space indented (matching oclif's own formatting) and a trailing
 * newline. Idempotent: canonicalizing already-canonical JSON returns identical
 * bytes.
 */
export function canonicalizeManifestJson(raw: string): string {
  const parsed = JSON.parse(raw) as JsonValue;
  return `${JSON.stringify(sortKeysDeep(parsed), null, 2)}\n`;
}
