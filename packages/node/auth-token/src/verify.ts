import { errors as joseErrors, jwtVerify } from 'jose';
import { AUDIENCE, ISSUER, JanusClaimsSchema } from './claims.js';
import type { VerifyResult } from './errors.js';
import { createJwksResolver, type JwksResolverConfig } from './jwks.js';

export interface VerifierConfig extends JwksResolverConfig {}

export interface Verifier {
  verify(token: string): Promise<VerifyResult>;
}

/**
 * Builds a verifier with cached JWKS. Construct once at startup and reuse.
 */
export function createVerifier(config: VerifierConfig): Verifier {
  const jwks = createJwksResolver(config);

  return {
    async verify(token: string): Promise<VerifyResult> {
      let payload: unknown;
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['EdDSA'],
        });
        payload = verified.payload;
      } catch (err) {
        return mapJoseError(err);
      }

      const parsed = JanusClaimsSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, reason: 'missing-claims', detail: parsed.error.message };
      }
      return { ok: true, claims: parsed.data };
    },
  };
}

function mapJoseError(err: unknown): VerifyResult {
  if (err instanceof joseErrors.JWTExpired) {
    return { ok: false, reason: 'expired' };
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return { ok: false, reason: 'invalid-issuer' };
    if (err.claim === 'aud') return { ok: false, reason: 'invalid-audience' };
    return { ok: false, reason: 'missing-claims', detail: err.message };
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return { ok: false, reason: 'unknown-key' };
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return { ok: false, reason: 'invalid-signature' };
  }
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: false, reason: 'malformed', detail: err instanceof Error ? err.message : String(err) };
}
