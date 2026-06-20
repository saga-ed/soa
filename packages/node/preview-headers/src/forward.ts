import { getPreviewHeaders } from './store.js';

/**
 * Merge the current request's preview headers into an outbound header bag,
 * making "forward the preview routing headers" the default for any S2S client
 * instead of a step each client must remember (the propagation gap the fleet
 * audit flagged: a client that forgets to spread `getPreviewHeaders()` silently
 * routes that hop to `main`).
 *
 * Framework-agnostic — drop it into any tRPC `httpBatchLink` headers function or
 * fetch wrapper. The caller's own headers (auth token, cookie) take precedence
 * over the preview headers per-key, so passing the existing bag never has a
 * preview header clobber an auth header.
 *
 * @example
 *   // tRPC httpBatchLink:
 *   headers: async () => withPreviewHeaders({ 'x-service-token': await token() })
 *
 *   // fetch:
 *   fetch(url, { headers: withPreviewHeaders({ cookie }) })
 */
export function withPreviewHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  return { ...getPreviewHeaders(), ...headers };
}
