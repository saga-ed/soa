import { buildLoginUrl } from './url.js';
import type { RedirectInput } from './types.js';

export interface RedirectOptions {
  /** Override the default host. Skips preview cookie if supplied. */
  defaultHost?: string;
  /** Inject navigation for tests. Default uses `window.location.assign`. */
  navigate?: (url: string) => void;
}

export function redirectToLogin(input: RedirectInput, opts: RedirectOptions = {}): void {
  const url = buildLoginUrl(input, { defaultHost: opts.defaultHost });
  const nav = opts.navigate ?? defaultNavigate;
  nav(url);
}

function defaultNavigate(url: string): void {
  if (typeof window === 'undefined') {
    throw new Error('redirectToLogin called outside a browser context — pass opts.navigate');
  }
  window.location.assign(url);
}
