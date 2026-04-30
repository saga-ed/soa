import type { RedirectInput } from './types.js';
import { readPreviewLoginVariant } from './preview.js';

export const DEFAULT_LOGIN_HOST = 'login.wootdev.com';
export const DEFAULT_NEXT_SUFFIX_ALLOWLIST: readonly string[] = ['.wootdev.com'];

export interface BuildLoginUrlOptions {
  /** Default host when no preview cookie or explicit override is given. */
  defaultHost?: string;
  /** Override for the host. Skips preview cookie read when supplied. */
  hostOverride?: string;
  /** Override for the cookie source — used in tests / SSR. */
  cookieHeader?: string;
}

export function buildLoginUrl(input: RedirectInput, opts: BuildLoginUrlOptions = {}): string {
  const defaultHost = opts.defaultHost ?? DEFAULT_LOGIN_HOST;
  const host = resolveHost({ ...opts, override: input.loginHost ?? opts.hostOverride, defaultHost });

  const params = new URLSearchParams();
  params.set('next', input.next);
  if (input.reasons.length > 0) {
    params.set('reasons', input.reasons.join(','));
  }
  return `https://${host}/?${params.toString()}`;
}

function resolveHost(args: { override?: string; cookieHeader?: string; defaultHost: string }): string {
  if (args.override) return args.override;
  const variant = readPreviewLoginVariant(args.cookieHeader);
  if (!variant) return args.defaultHost;
  return `${variant}.${args.defaultHost}`;
}

/**
 * Validates that a `next` URL belongs to the allowed host suffix set.
 * Same logic the gate lambda applies — exported so frontends can fail fast.
 */
export function isAllowedNext(next: string, allowlist: readonly string[] = DEFAULT_NEXT_SUFFIX_ALLOWLIST): boolean {
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return allowlist.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix));
}
