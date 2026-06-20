/**
 * The canonical preview-routing header prefix. Every Saga service routes
 * preview/sandbox traffic with `x-saga-preview-<service>: sandbox-<name>`; the
 * ALB matches on that header + value and sends the hop to the preview deployment
 * of `<service>` instead of `main`. This is the HTTP-plane counterpart of the
 * event-plane `applyPreviewTag()` in `@saga-ed/soa-event-envelope`.
 */
export const HEADER_PREFIX = 'x-saga-preview-';

/**
 * Normalize a service key into a full preview-header name. Accepts either the
 * short service key (`iam-api`) or the already-prefixed header name
 * (`x-saga-preview-iam-api`) and returns the lowercased full header name. Lets
 * config (e.g. an origination map) be written in the terse short form.
 *
 * @example
 *   toPreviewHeaderName('iam-api')                // → 'x-saga-preview-iam-api'
 *   toPreviewHeaderName('x-saga-preview-iam-api') // → 'x-saga-preview-iam-api'
 */
export function toPreviewHeaderName(serviceKeyOrHeader: string): string {
  const trimmed = serviceKeyOrHeader.trim().toLowerCase();
  return trimmed.startsWith(HEADER_PREFIX) ? trimmed : `${HEADER_PREFIX}${trimmed}`;
}

/**
 * The inverse of {@link toPreviewHeaderName}: strip the prefix to recover the
 * service key. Returns the input unchanged if it carries no prefix.
 *
 * @example
 *   toServiceKey('x-saga-preview-iam-api') // → 'iam-api'
 */
export function toServiceKey(header: string): string {
  const lower = header.trim().toLowerCase();
  return lower.startsWith(HEADER_PREFIX) ? lower.slice(HEADER_PREFIX.length) : lower;
}

/**
 * Filter an inbound header bag down to just the `x-saga-preview-*` string
 * entries (lowercased keys). Shared by the capture middleware and any caller
 * that wants to extract preview headers from a raw request without the
 * AsyncLocalStorage plumbing. Array-valued headers (which a routing header
 * should never be) are skipped.
 */
export function extractPreviewHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith(HEADER_PREFIX) && typeof value === 'string') {
      out[lower] = value;
    }
  }
  return out;
}
