/**
 * @saga-ed/soa-auth-contracts
 *
 * Canonical wire shapes for fleet authentication and authorization.
 * See docs/auth/ for the ADRs that ground these schemas.
 *
 * This package is runtime-agnostic and crypto-free. Verification of
 * signatures, signing of tokens, and key management live in downstream
 * packages that import these schemas.
 */

export * from './spiffe.js';
export * from './jwt-claims.js';
export * from './two-headers.js';
export * from './audit-event.js';
