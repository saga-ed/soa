import { createRemoteJWKSet, type JWTHeaderParameters } from 'jose';

export interface JwksResolverConfig {
  jwksUrl: string;
  /** TTL for the in-process JWKS cache, in seconds. Default 300 (5 minutes). */
  cacheSeconds?: number;
  /** Cooldown between forced refetches when a kid is unknown, in seconds. Default 30. */
  cooldownSeconds?: number;
}

/**
 * Returns a `jose`-compatible key resolver that fetches and caches the JWKS
 * document, with automatic refresh when an unknown kid is encountered.
 *
 * Cached per-config: callers should construct one resolver at startup and
 * reuse it.
 */
export function createJwksResolver(config: JwksResolverConfig) {
  const cacheMaxAge = (config.cacheSeconds ?? 300) * 1000;
  const cooldown = (config.cooldownSeconds ?? 30) * 1000;
  return createRemoteJWKSet(new URL(config.jwksUrl), {
    cacheMaxAge,
    cooldownDuration: cooldown,
  });
}

export type JwksResolver = (header: JWTHeaderParameters) => Promise<CryptoKey>;
