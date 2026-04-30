/**
 * Parses a `WWW-Authenticate` header value emitted by `@saga-ed/soa-auth-token`'s
 * middleware. Returns the embedded login URL when present, else null.
 *
 * Format: `Janus realm="wootdev", login="https://login.wootdev.com/?next=…&reasons=…"`
 */
export function parseJanusWwwAuthenticate(headerValue: string | null | undefined): { loginUrl: string } | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!/^Janus(\s|$)/i.test(trimmed)) return null;
  const match = trimmed.match(/login="([^"]+)"/);
  if (!match || !match[1]) return null;
  return { loginUrl: match[1] };
}
