import { z } from 'zod';
import { SpiffeIdSchema } from './spiffe.js';

/**
 * Canonical JWT claim shape per ADR 0001.
 *
 * This file defines schemas; it does not perform crypto. Verification of
 * signature, audience, and expiry happens at runtime in services that import
 * this schema.
 */

export const TENANT_ID_RE = /^(district|school|cohort):[a-zA-Z0-9_-]+$/;

/**
 * `saga.tenant` claim — tenant binding.
 *
 * Format: `<tenant-type>:<id>` where tenant-type is one of district/school/cohort.
 * For the v1 plan only `district:<id>` is in use, but the format reserves
 * room for narrower scopes.
 */
export const TenantIdSchema = z
    .string()
    .regex(TENANT_ID_RE, 'tenant must match <type>:<id>');
export type TenantId = z.infer<typeof TenantIdSchema>;

/**
 * `cnf` claim per RFC 7800 / RFC 9449.
 *
 * Today only `jkt` (JWK SHA-256 thumbprint) is supported. Future expansion
 * (e.g., x5t#S256 for mTLS-bound) lives here.
 */
export const ConfirmationSchema = z
    .object({
        jkt: z.string().min(32, 'cnf.jkt must be a JWK thumbprint'),
    })
    .strip();
export type Confirmation = z.infer<typeof ConfirmationSchema>;

/**
 * Standard JWT claims (RFC 7519) we depend on.
 */
const StandardClaimsSchema = z.object({
    iss: z.string().url('iss must be an absolute URL'),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]),
    sub: SpiffeIdSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().min(1),
});

/**
 * Saga-namespaced custom claims.
 *
 * - `saga.tenant` is required for user tokens, omitted/null for service tokens
 *   (a service token represents a workload, not a user-in-tenant context).
 * - `saga.session` ties an issued token back to the server-side session record.
 * - `saga.scope` narrows what the token is allowed to do — used during token
 *   exchange (RFC 8693) when scope is reduced for a downstream call.
 */
const SagaClaimsSchema = z.object({
    'saga.tenant': TenantIdSchema.nullable().optional(),
    'saga.session': z.string().min(1).nullable().optional(),
    'saga.scope': z.array(z.string().min(1)).optional(),
});

/**
 * Full canonical claim schema.
 *
 * `cnf` is optional today (plain bearer); ADR 0001 calls it out as required
 * for DPoP-bound tokens. Services that require DPoP-bound tokens validate
 * `cnf` independently after parsing.
 */
export const CanonicalJwtClaimsSchema = StandardClaimsSchema.merge(
    SagaClaimsSchema,
).extend({
    cnf: ConfirmationSchema.optional(),
});

export type CanonicalJwtClaims = z.infer<typeof CanonicalJwtClaimsSchema>;

/**
 * Distinguish user tokens from service tokens by inspecting the parsed
 * claim shape:
 *   - User token: `sub` is `spiffe://saga.<env>/user/<uuid>`, tenant is set.
 *   - Service token: `sub` is `spiffe://saga.<env>/<service>[/<component>]`,
 *     tenant is omitted/null.
 *
 * This helper does not parse — it operates on already-validated claims.
 */
export function isUserToken(claims: CanonicalJwtClaims): boolean {
    return /^spiffe:\/\/saga\.[^/]+\/user\/[0-9a-f-]{36}$/i.test(claims.sub);
}

export function isServiceToken(claims: CanonicalJwtClaims): boolean {
    return !isUserToken(claims);
}

/**
 * Audience match. Accepts both string and array audience claims (RFC 7519).
 * Returns true if `expected` is the audience or one member of the array.
 */
export function audienceMatches(
    claims: Pick<CanonicalJwtClaims, 'aud'>,
    expected: string,
): boolean {
    if (typeof claims.aud === 'string') return claims.aud === expected;
    return claims.aud.includes(expected);
}

/**
 * Expiry check with optional clock skew tolerance (default 30s per ADR 0001).
 * Returns true when the token has expired.
 */
export function isExpired(
    claims: Pick<CanonicalJwtClaims, 'exp'>,
    nowSeconds: number = Math.floor(Date.now() / 1000),
    skewSeconds = 30,
): boolean {
    return nowSeconds - skewSeconds > claims.exp;
}
