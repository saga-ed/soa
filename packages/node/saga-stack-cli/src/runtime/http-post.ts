/**
 * The HTTP-POST-with-Set-Cookie-capture seam (M11 — the curl half of login_user).
 *
 * The existing `HealthProber` (`health.ts`) only does a GET and reports `ok`/`status` —
 * it throws away headers. The native headless login needs the RESPONSE COOKIES from a
 * POST (`curl -c "$COOKIE_JAR"`), so this is a sibling seam: POST a JSON body with an
 * explicit `Origin` header (iam's origin-check is load-bearing) and return the captured
 * `Set-Cookie` header values plus the status. Production wires `makeRealCookiePoster()`
 * (the only place this network POST is made); the login TESTS substitute a fake that
 * returns canned Set-Cookies, so the devLogin flow is asserted with NO network.
 *
 * NEVER throws for a down endpoint: a refused connection / timeout / DNS error folds to
 * `{ status: 0, ok: false, setCookies: [] }`, so the caller surfaces the persona hint
 * instead of crashing.
 *
 * INVARIANT (plan hard constraint): network IO lives only in `src/runtime/**`.
 */

/** The outcome of a cookie-capturing POST. */
export interface PostResult {
  /** HTTP status, or `0` on a transport/timeout error (never threw). */
  status: number;
  /** True iff a 2xx response was received. */
  ok: boolean;
  /** The raw `Set-Cookie` header values from the response (empty on error). */
  setCookies: string[];
}

/** Options for one cookie-capturing POST. */
export interface PostOptions {
  /** The `Origin` header value (iam's own origin — required by its origin-check). */
  origin: string;
  /** The request body (a JSON string). */
  body: string;
  /** Abort timeout in ms; default 10000 (up.sh's `curl --max-time 10`). */
  timeoutMs?: number;
}

/** The injectable POST seam. One method: POST a JSON body, capture `Set-Cookie`s. */
export interface CookiePoster {
  post(url: string, opts: PostOptions): Promise<PostResult>;
}

/**
 * The production poster: a `fetch` POST (JSON) with the given `Origin`, a short
 * AbortController timeout, and `redirect: 'manual'` (a 3xx must not be followed —
 * we want iam's own response + its Set-Cookies, not a redirect target's). Captures
 * `Set-Cookie` via `Headers.getSetCookie()` (the one API that preserves multiple
 * Set-Cookie headers). Any failure folds to `{ status: 0, ok: false, setCookies: [] }`.
 */
export function makeRealCookiePoster(): CookiePoster {
  return {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: opts.origin },
          body: opts.body,
          redirect: 'manual',
          signal: controller.signal,
        });
        const setCookies =
          typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        return { status: res.status, ok: res.ok, setCookies };
      } catch {
        return { status: 0, ok: false, setCookies: [] };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
