import { parse, serialize, type SerializeOptions } from 'cookie';
import { COOKIE_NAME } from './claims.js';
import { DEFAULT_TTL_SECONDS } from './mint.js';

export interface CookieDomainOptions {
  /** Cookie Domain attribute. Default `.wootdev.com`. */
  domain?: string;
  /** Cookie Path attribute. Default `/`. */
  path?: string;
  /** Override Max-Age (seconds). Default matches the token's TTL (8h). */
  maxAgeSeconds?: number;
}

export function setJanusCookieHeader(token: string, opts: CookieDomainOptions = {}): string {
  const options: SerializeOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: opts.domain ?? '.wootdev.com',
    path: opts.path ?? '/',
    maxAge: opts.maxAgeSeconds ?? DEFAULT_TTL_SECONDS,
  };
  return serialize(COOKIE_NAME, token, options);
}

export function clearJanusCookieHeader(opts: CookieDomainOptions = {}): string {
  return serialize(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: opts.domain ?? '.wootdev.com',
    path: opts.path ?? '/',
    maxAge: 0,
  });
}

export function readJanusCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const parsed = parse(cookieHeader);
  return parsed[COOKIE_NAME] ?? null;
}
