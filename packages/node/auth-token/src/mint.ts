import { SignJWT, type KeyLike } from 'jose';
import { AUDIENCE, ISSUER } from './claims.js';

export const DEFAULT_TTL_SECONDS = 28800; // 8 hours

export interface MintInput {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  permissions: string[];
  authTime: number;
}

export interface MinterConfig {
  privateKey: KeyLike | Uint8Array;
  kid: string;
  ttlSeconds?: number;
  /** Override `now` for testing. Returns epoch seconds. */
  now?: () => number;
}

/**
 * Mints a Janus session JWT. The JWT is intended to be wrapped in the
 * `janus_session` cookie via `setJanusCookieHeader`.
 */
export async function mintJanusToken(
  input: MintInput,
  config: MinterConfig,
): Promise<string> {
  const now = (config.now ?? (() => Math.floor(Date.now() / 1000)))();
  const ttl = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const exp = now + ttl;

  return await new SignJWT({
    email: input.email,
    name: input.name,
    groups: input.groups,
    permissions: input.permissions,
    authTime: input.authTime,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: config.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(input.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(config.privateKey);
}
