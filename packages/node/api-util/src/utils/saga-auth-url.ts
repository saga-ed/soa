/**
 * Shared SagaAuth login-URL primitives for Saga backends.
 *
 * @spec specs/contracts/saga-auth-signal.spec.md (janus repo)
 *
 * These are the framework-agnostic leaf helpers that every SagaAuth-emitting
 * service needs to build its `WWW-Authenticate: SagaAuth …` challenge:
 *
 *  - {@link buildIamLoginUrl} assembles the login-frontend redirect URL
 *    (`reasons=iam_required` + optional `next=`);
 *  - {@link nextUrlFromReferer} safely derives the `next=` value from a Referer,
 *    rejecting anything that isn't a valid https URL (open-redirect prevention).
 *
 * Deliberately NOT shared here: the higher-level `createSagaAuthResponseMeta`
 * and the wire-format header builder. Those diverge by role — a relying-party
 * service (no refresh endpoint of its own) emits a login-only challenge, while
 * the issuer (iam-api) conditionally advertises `refresh=`. Each service
 * composes its own responseMeta on top of these primitives.
 */

/**
 * Returns the Referer as the redirect `next=`, but only if it parses as a
 * valid https URL. Rejects http and malformed values to avoid trusting a
 * hostile Referer into an open redirect.
 */
export function nextUrlFromReferer(referer: string | undefined): string | undefined {
  if (typeof referer !== 'string' || referer.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  return referer;
}

/**
 * Builds the login-frontend URL with `reasons=iam_required` and an optional
 * `next=`. Idempotent on trailing-slash variations of `loginBaseUrl`; a
 * non-root path on the base is preserved.
 */
export function buildIamLoginUrl(opts: { loginBaseUrl: string; next?: string }): string {
  const parsed = new URL(opts.loginBaseUrl.replace(/\/+$/, ''));
  const params = new URLSearchParams();
  params.set('reasons', 'iam_required');
  if (opts.next !== undefined) params.set('next', opts.next);
  const path = parsed.pathname === '' || parsed.pathname === '/' ? '/' : parsed.pathname;
  return `${parsed.origin}${path}?${params.toString()}`;
}
