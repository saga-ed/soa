import { AsyncLocalStorage } from 'node:async_hooks';
import { extractPreviewHeaders } from './header-keys.js';
import { parseOriginateMap } from './originate-map.js';

/**
 * Request-scoped storage for the preview headers captured off an inbound
 * request. Outbound HTTP clients read it (via {@link getPreviewHeaders}) to
 * forward the routing headers downstream, so the ALB routes each hop to the
 * matching preview deployment.
 */
const previewHeaderStore = new AsyncLocalStorage<Record<string, string>>();

/**
 * Static origination map, parsed once at module load from
 * `PREVIEW_ORIGINATE_MAP`. See {@link parseOriginateMap} for the rationale and
 * format. Empty/unset → forward-only behavior, unchanged.
 */
const ORIGINATE_MAP = parseOriginateMap(process.env.PREVIEW_ORIGINATE_MAP);

/**
 * Capture the `x-saga-preview-*` headers from an inbound request's header bag
 * and run `fn` with them available via {@link getPreviewHeaders}. Framework-
 * agnostic: pass any `Record<string, string | string[] | undefined>` (e.g.
 * `req.headers`). When the request carried no preview headers, `fn` runs without
 * a new scope (the origination map, if any, still applies).
 *
 * @example
 *   app.use((req, _res, next) => runWithPreviewHeaders(req.headers, next));
 */
export function runWithPreviewHeaders<T>(
  headers: Record<string, string | string[] | undefined>,
  fn: () => T,
): T {
  const captured = extractPreviewHeaders(headers);
  if (Object.keys(captured).length > 0) {
    return previewHeaderStore.run(captured, fn);
  }
  return fn();
}

/**
 * Get the preview headers to attach to an outbound call from the current
 * request context.
 *
 * Headers captured from the inbound request take precedence over the static
 * origination map per-key: a browser-seeded `x-saga-preview-iam-api` overrides
 * the map's entry for that one header while the map still supplies any other
 * downstream the inbound request did not carry. With no map configured this is
 * exactly the inbound store (forward-only behavior unchanged) — and an empty
 * object when called outside a {@link runWithPreviewHeaders} scope.
 */
export function getPreviewHeaders(): Record<string, string> {
  return { ...ORIGINATE_MAP, ...(previewHeaderStore.getStore() ?? {}) };
}
