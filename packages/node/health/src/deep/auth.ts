import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Authorizer for the `internal` detail level: `Authorization: Bearer <token>`, compared in constant
 * time over sha256 digests (equal length, no length leak). `getToken` is where the service plugs in
 * its SSM-sourced secret; an unset/empty token denies everything.
 */
export function createBearerAuthorizer(getToken: () => string | undefined): (req: unknown) => boolean {
  return (req) => {
    const token = getToken();
    if (!token) return false;
    const headers = (req as { headers?: Record<string, string | string[] | undefined> } | null)?.headers;
    const raw = headers?.authorization ?? headers?.Authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    const m = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
    if (!m?.[1]) return false;
    return timingSafeEqual(digest(m[1]), digest(token));
  };
}
