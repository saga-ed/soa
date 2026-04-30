import { redirectToLogin } from './redirectToLogin.js';
import { parseJanusWwwAuthenticate } from './wwwAuth.js';
import type { JanusReason } from './types.js';

export interface WrapFetchOptions {
  /** Default host when no preview cookie or explicit override is given. */
  defaultHost?: string;
  /** Reasons to send if the response doesn't already carry a login URL. Defaults to `['unauthenticated']`. */
  fallbackReasons?: JanusReason[];
  /**
   * If true, navigation is suppressed on 401 — the wrapped fetch resolves
   * normally with the original response. Useful for tests or for routes that
   * want to handle 401 themselves.
   */
  suppressNavigation?: boolean;
  /** Inject navigation for tests. Default uses `window.location.assign`. */
  navigate?: (url: string) => void;
  /**
   * Inject the current URL for tests / SSR. Default reads `window.location.href`
   * at navigation time.
   */
  currentUrl?: () => string;
}

/**
 * Wraps a fetch implementation so that 401 responses with a Janus
 * `WWW-Authenticate` header trigger a redirect to the login page. Other
 * responses pass through unchanged.
 */
export function wrapFetchForJanus(
  fetchImpl: typeof fetch,
  opts: WrapFetchOptions = {},
): typeof fetch {
  return async function janusFetch(input, init) {
    const res = await fetchImpl(input, init);
    if (res.status !== 401) return res;
    if (opts.suppressNavigation) return res;

    const header = res.headers.get('www-authenticate');
    const parsed = parseJanusWwwAuthenticate(header);
    if (!parsed) return res;

    const next = (opts.currentUrl ?? defaultCurrentUrl)();
    const reasons = opts.fallbackReasons ?? ['unauthenticated'];

    // Prefer the server-supplied login URL (which already encodes the right
    // login host based on the issuing service's deployment). Fall back to the
    // client-side builder when the server URL doesn't include a `next` for us.
    const final = ensureNext(parsed.loginUrl, next, reasons);
    (opts.navigate ?? defaultNavigate)(final);
    return res;
  };
}

function ensureNext(loginUrl: string, fallbackNext: string, fallbackReasons: JanusReason[]): string {
  let url: URL;
  try {
    url = new URL(loginUrl);
  } catch {
    return loginUrl;
  }
  if (!url.searchParams.has('next')) url.searchParams.set('next', fallbackNext);
  if (!url.searchParams.has('reasons')) url.searchParams.set('reasons', fallbackReasons.join(','));
  return url.toString();
}

function defaultCurrentUrl(): string {
  if (typeof window === 'undefined') {
    throw new Error('wrapFetchForJanus default currentUrl requires a browser — pass opts.currentUrl');
  }
  return window.location.href;
}

function defaultNavigate(url: string): void {
  if (typeof window === 'undefined') {
    throw new Error('wrapFetchForJanus default navigate requires a browser — pass opts.navigate');
  }
  window.location.assign(url);
}

// Re-exported for advanced callers.
export { redirectToLogin };
