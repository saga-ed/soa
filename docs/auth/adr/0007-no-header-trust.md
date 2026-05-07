# ADR 0007 — No header-trusted identity in resource services

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 5 and § 8](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#5-service-to-service-authentication)

## Context

Today's program-hub trusts an `x-organization-id` header to scope tenant access; rostering's tRPC accepts `x-user-id` as a fallback when session-cookie resolution fails. Both are defensible as dev conveniences and indefensible in production:

- `x-user-id` lets a caller claim any userId if the cookie is missing — header injection equals account takeover.
- `x-organization-id` lets a caller claim any tenant — and current code does not verify the user is actually a member of that tenant before answering queries.

These two patterns are the highest-severity issues surfaced by the current-state audit (see plan.md). They predate the broader fleet-auth design and should be removed independently of (and earlier than) anything else.

## Decision

### Identity is *derived*, never *trusted*

In production, identity facts (userId, tenantId, roles) MUST come from one of:

1. The verified session (rostering's session store, today opaque-cookie-backed) — for end-user calls.
2. The verified JWT `sub` and `saga.tenant` claims — when JWTs roll out (ADR 0001).
3. The verified `X-Saga-Caller` (cryptographically attested per ADR 0002, enforce phase) — for service-to-service calls.

**No header value supplied by the request body or headers is used as an identity fact without verification against one of the above.**

### `x-user-id` is removed outright

- No production scenario justifies it.
- Dev mode runs with a real session via `auth.devLogin`.
- Rostering's startup MUST refuse to boot in `NODE_ENV=production` if any code path enables this fallback.

### `x-organization-id` becomes a *requested* tenant, never a *trusted* one

When a request includes `x-organization-id`:

1. The session/JWT determines the user's set of tenant memberships.
2. The header is treated as the user's *requested context* for this call.
3. The service accepts the header value only if it matches a tenant in the membership set.
4. If the header value is not in the set, the request fails `FORBIDDEN`.
5. If the header is missing, the service uses a deterministic default (e.g., the user's primary tenant) or rejects the request with `BAD_REQUEST`, depending on the procedure's contract.

### Services ship test coverage for both rejection paths

Every resource service that previously accepted these headers MUST add tests asserting:

- A request with a fabricated `x-organization-id` for a non-member tenant is rejected with `FORBIDDEN`.
- A request with no session and a fabricated `x-user-id` is rejected with `UNAUTHORIZED`.

### Logging

When a request is rejected for header/identity mismatch, the service emits `audit.decision.v1` with `decision = "deny"`, `reason = "tenant_mismatch"` or `"missing_session"`, and the rejected header value (the rejected value is fine to log; it's an attempted claim, not an asserted truth).

## Consequences

**Positive:**
- Closes the largest current-state vulnerability surface immediately.
- Decoupled from the larger seams (JWT, mTLS, FGA) — can land before any of them.
- Audit log records show every rejected attempt, surfacing reconnaissance.

**Negative:**
- A small amount of dev tooling that injected `x-user-id` for convenience must move to using `auth.devLogin`. The convenience was unsafe in any case.
- Procedures that did not previously care which tenant they ran in must now make the choice explicit.

## Alternatives considered

- **Sign the headers (HMAC over `x-user-id` etc.):** rejected. Adds complexity without solving the underlying problem; if you're going to sign something, sign a JWT.
- **Trust headers only when the request originates from inside the VPC:** rejected. Network-perimeter trust is exactly the model that fails when an attacker gets inside (well-documented as defense-in-depth failure).
- **Keep the headers but log heavily:** rejected. Logging an attack while letting it succeed is not a defense.

## References

- OWASP — Authentication Cheat Sheet (header-trust antipatterns)
- ADR 0001 — JWT claim shape (the *correct* identity carrier)
- ADR 0002 — Two-headers invariant
- ADR 0004 — Audit event shape (deny-event logging)
