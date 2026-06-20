import { toPreviewHeaderName } from './header-keys.js';

/**
 * Parse a `PREVIEW_ORIGINATE_MAP`-style string into a header→value map.
 *
 * The capture store (see `./store`) only FORWARDS headers that arrived on the
 * inbound request, so a service with no browser/dash entrypoint — a headless
 * projection consumer, or a local-source service in a synthetic-dev mesh —
 * cannot route a downstream call to a sandbox dependency: its inbound request
 * never carried the header. The origination map lets such a service ORIGINATE
 * the header for a sandbox downstream.
 *
 * Format: comma-separated `key=value` pairs. The key may be the short service
 * name (`iam-api`) or the full `x-saga-preview-` header; the value is the literal
 * ALB routing slug `sandbox-<name>` the sandbox deploy registers. e.g.:
 *   PREVIEW_ORIGINATE_MAP=iam-api=sandbox-alice,scheduling-api=sandbox-alice
 *
 * Empty/unset (the all-local and production cases) yields an empty map, so the
 * forward-only behavior is unchanged when no origination is configured.
 */
export function parseOriginateMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [rawKey, ...rest] = pair.split('=');
    const key = (rawKey ?? '').trim();
    const value = rest.join('=').trim();
    if (!key || !value) continue;
    map[toPreviewHeaderName(key)] = value;
  }
  return map;
}
