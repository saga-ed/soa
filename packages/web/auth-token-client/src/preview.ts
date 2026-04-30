/**
 * Reads the `x-saga-preview-login` cookie. When set (e.g. via the switchboard
 * UI), the user has elected to bounce all login redirects through a specific
 * login frontend variant — for example `pr-2` to use `pr-2.login.wootdev.com`
 * rather than the default `login.wootdev.com`.
 *
 * Server-side rendering: pass an explicit `cookieHeader` to skip `document`.
 */
export const PREVIEW_LOGIN_COOKIE = 'x-saga-preview-login';

export function readPreviewLoginVariant(cookieHeader?: string): string | null {
  const source = cookieHeader ?? (typeof document !== 'undefined' ? document.cookie : '');
  if (!source) return null;

  for (const segment of source.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const name = segment.slice(0, eq).trim();
    if (name !== PREVIEW_LOGIN_COOKIE) continue;
    const value = decodeURIComponent(segment.slice(eq + 1).trim());
    if (!value) return null;
    if (!isSafeVariant(value)) return null;
    return value;
  }
  return null;
}

/**
 * Variant names appear in subdomains, so allow only host-safe characters.
 * Rejects anything that could escape the subdomain slot (dots, slashes, etc.).
 */
function isSafeVariant(value: string): boolean {
  return /^[a-zA-Z0-9-]{1,63}$/.test(value);
}
