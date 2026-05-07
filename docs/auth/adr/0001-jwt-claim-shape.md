# ADR 0001 — Canonical JWT claim shape

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 3 (Tokens)](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#3-tokens)

## Context

Multiple services will issue, forward, and verify JWTs. Without a fixed claim shape, each issuer drifts and verifiers must handle a matrix of variations. A single canonical shape enables:

- One verifier implementation in `@saga-ed/soa-auth-contracts`
- Audience-pinned tokens via token-exchange (RFC 8693) without re-shaping
- DPoP key binding (RFC 9449) plugged in via the `cnf.jkt` claim later
- Tenant binding consumable by every service without a separate header

## Decision

All Saga-issued JWTs MUST conform to this claim shape:

```jsonc
{
  "iss": "https://auth.saga.<env>",       // issuer; environment-specific URL
  "aud": "<service-id-or-spiffe-id>",     // pinned per audience via token-exchange
  "sub": "spiffe://saga.<env>/user/<uuid>", // SPIFFE-formatted subject (see ADR 0006)
  "iat": <unix-seconds>,
  "exp": <unix-seconds>,                  // ≤ 15 min for access tokens
  "jti": "<uuid>",                        // unique per token; safe to log
  "saga.tenant": "district:<id>",         // primary tenant binding
  "saga.session": "<opaque-jti>",         // links back to server-side session
  "saga.scope": ["<scope>", ...],         // optional, narrowed via token-exchange
  "cnf": { "jkt": "<DPoP-key-thumbprint>" } // optional today, required for DPoP-bound tokens
}
```

### Service tokens

Tokens issued *to* a service (not on behalf of a user) follow the same shape with:
- `sub` set to the *service's* SPIFFE ID (`spiffe://saga.<env>/<service>`)
- `saga.tenant` omitted or `null` (tenant comes from the user side of an on-behalf-of exchange)
- `saga.session` omitted

### Validation rules

Every verifier MUST:

1. Reject tokens with a missing or unrecognized `iss`.
2. Reject tokens whose `aud` does not match the verifying service's audience identifier.
3. Reject tokens past `exp` (with at most 30s clock skew).
4. Reject tokens with malformed `sub` (not a valid SPIFFE ID per ADR 0006).
5. Verify `cnf.jkt` against the request's DPoP proof, if present.
6. **Never** trust unsigned JWTs; reject `alg=none`.

### Algorithm

- Production: **ES256** (ECDSA P-256, SHA-256). Key pair, public keys served from JWKS.
- Internal-only fallback: **HS256** with a per-environment shared secret, only for service-to-service tokens never seen by end users.

## Consequences

**Positive:**
- Single verifier; no per-service variations.
- DPoP, token-exchange, and Cognito all integrate as additive populations of existing fields.
- Tenant binding is in the token, not a forgeable header (closes the §0007 risk).

**Negative:**
- Custom claim names (`saga.tenant`, `saga.session`) require all consumers to import from `@saga-ed/soa-auth-contracts` to avoid string drift.
- Switching JWT libraries means re-validating against the schema; mitigated by the Zod schema in the contracts package.

## Alternatives considered

- **Standard claims only (no `saga.*`):** rejected. Tenant and session linkage are critical; encoding them in `aud` or `sub` overloads those fields and breaks token-exchange.
- **Bare opaque session token (no JWT):** rejected. Saga's current model. Forces every consumer to call back to the issuer for every request — does not scale, does not support audience pinning.

## References

- RFC 7519 — JWT
- RFC 8693 — OAuth 2.0 Token Exchange
- RFC 9449 — DPoP
- RFC 9068 — JWT profile for OAuth 2.0 access tokens
- ADR 0006 — SPIFFE ID format
