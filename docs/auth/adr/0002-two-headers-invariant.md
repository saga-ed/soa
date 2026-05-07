# ADR 0002 — Two-headers invariant

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 5 (Service-to-service authentication)](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#5-service-to-service-authentication)

## Context

Internal service-to-service calls need two facts that are independently verifiable:

1. **Caller workload identity** — *which service is making this call?*
2. **Subject identity** — *which user (if any) is this call on behalf of?*

Conflating them is the canonical confused-deputy bug: a service grants access because *some* authenticated identity is present, without distinguishing whether that's the *caller's* identity or the *user's*.

## Decision

Every internal call (HTTP, tRPC, gRPC) MUST carry both:

| Aspect | Header | Today | Tomorrow |
|---|---|---|---|
| Caller workload identity | `X-Saga-Caller` | SPIFFE-formatted string, structurally validated | mTLS cert SAN (ECS) or SigV4 signer (Lambda), cryptographically verified |
| Subject identity | `Authorization: Bearer <jwt>` | JWT per ADR 0001 | DPoP-bound JWT per ADR 0001 + RFC 9449 |

Both headers MUST be parsed and verified independently. **A failure of either rejects the request.**

### Header values

- `X-Saga-Caller`: a single SPIFFE ID (ADR 0006), e.g. `spiffe://saga.prod/program-hub`. No additional metadata; the workload's identity is the value.
- `Authorization`: standard OAuth bearer; the JWT carries the user identity and tenant.

### Service-only calls (no end user)

When a service calls another service for its own purposes (e.g., a background worker), `Authorization` carries a *service token* — a JWT whose `sub` is the calling service's SPIFFE ID and whose `saga.tenant` is omitted. The receiver knows there is no user context and treats `saga.tenant`-scoped operations as forbidden.

### Logging

Every internal request MUST log both identities (caller SPIFFE ID, subject `sub` and `jti`). Audit events (ADR 0004) capture both fields explicitly.

### Rollout

Phase A (this PR set):
- Define the headers in `@saga-ed/soa-auth-contracts`
- Outbound callers populate `X-Saga-Caller` with their static SPIFFE ID
- Inbound services run a `requireTwoHeaders` middleware in **shadow mode** — log + metric on missing/invalid, do not reject
- Metric: `saga_two_headers_missing_total{service, reason}`

Phase B (later, behind a flag once the metric is at zero):
- Flip middleware to **enforce mode** — reject `UNAUTHORIZED` on missing/invalid
- Caller value verified against mTLS SAN (ECS) or SigV4 principal (Lambda)
- The header becomes redundant with the cryptographic check but is preserved as the canonical identity name in audit logs

## Consequences

**Positive:**
- Eliminates confused-deputy by construction — services cannot accidentally treat caller identity as subject identity.
- Forward-compatible with mTLS/SigV4 without code change in receivers — only the verifier swaps.
- Audit logs always carry both identities.

**Negative:**
- Every outbound call site must populate `X-Saga-Caller` (small ergonomic cost; helped by shared client wrappers).
- Shadow-then-enforce migration requires watching the metric; some teams may delay flipping.

## Alternatives considered

- **mTLS only, no header:** rejected for now. Cryptographic SAN extraction varies by load balancer / mesh / runtime. The header is a stable in-app contract that survives infra change.
- **One token carrying both identities (`act` claim only):** rejected. The two identities have different lifetimes (caller is workload-stable; subject is per-user) and different revocation paths. Separate carriers makes this clear.
- **Sign just the subject token; leave caller implicit:** rejected. That's exactly the confused-deputy setup we're avoiding.

## References

- RFC 8693 — OAuth 2.0 Token Exchange (`act` claim records on-behalf-of chains)
- RFC 8705 — mTLS-bound tokens
- ADR 0001 — JWT claim shape
- ADR 0006 — SPIFFE ID format
- ADR 0007 — No header-trusted identity
