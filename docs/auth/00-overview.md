# Saga Fleet Auth — Overview

This directory holds the canonical decisions for fleet-wide authentication and authorization across Saga's microservices. These ADRs are the *source of truth* every service repo cites; if a service repo's auth doc disagrees with an ADR here, the ADR wins.

## Why this lives in `soa`

`soa` ships the shared packages every service consumes. The wire shapes (JWT claims, event envelopes, audit events, SPIFFE IDs, header names) are defined here so that no service can drift unilaterally. Think of these ADRs as the *types* and the per-service implementation as the *implementations*.

## Reading order for newcomers

1. The concept primer in [`saga-dash/docs/auth/concepts.md`](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md) — explains every term used here for engineers without a security background.
2. The minimal-change rollout plan in [`saga-dash/docs/auth/plan.md`](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/plan.md) — what we're doing and in what order.
3. The ADRs below — *why* each seam is shaped the way it is.
4. The source code in `packages/core/auth-contracts/` — the runtime artifact.

## ADR index

| # | Title | Status |
|---|---|---|
| [0001](./adr/0001-jwt-claim-shape.md) | Canonical JWT claim shape | Accepted |
| [0002](./adr/0002-two-headers-invariant.md) | Two-headers invariant for service-to-service calls | Accepted |
| [0003](./adr/0003-signed-event-envelope.md) | Signed event envelope (HMAC-SHA256) | Accepted |
| [0004](./adr/0004-audit-event-shape.md) | Audit event shape (`audit.decision.v1`) | Accepted |
| [0005](./adr/0005-openfga-model-as-source-of-truth.md) | OpenFGA model as source of truth | Accepted |
| [0006](./adr/0006-spiffe-id-format.md) | SPIFFE ID format for service identity | Accepted |
| [0007](./adr/0007-no-header-trust.md) | No header-trusted identity in resource services | Accepted |

## The seven seams in one sentence each

1. **JWT claim shape** — every issued token has `iss`, `aud`, `sub` (SPIFFE-formatted), `saga.tenant`, `saga.session`, `cnf.jkt`. Future DPoP / Cognito / token-exchange work plugs into this shape unchanged.
2. **Two-headers invariant** — every internal call carries caller workload identity (`X-Saga-Caller`) *and* subject identity (`Authorization`). Both are verified independently. Today caller identity is a string; tomorrow it's an mTLS-verified SPIFFE SAN.
3. **Signed event envelope** — events optionally carry an HMAC-SHA256 signature. Producers sign when a signing key is configured; consumers verify in shadow mode (log) or enforce mode (reject). The seam exists today; enforcement flips later.
4. **Audit event shape** — every authz decision, mutation, and identity event emits an `audit.decision.v1` record. Today the writer is a structured logger; the Merkle-chained Postgres + S3 Object Lock storage swaps in later without callers changing.
5. **OpenFGA model as source of truth** — the `.fga` model is the only place tuple types and relations are defined. Services *check*; the sync worker *writes*. Today the model lives in-repo without a deployed FGA store; runtime checks land later.
6. **SPIFFE ID format** — `spiffe://saga.<env>/<service>` is the canonical workload identifier. Used in mTLS SANs, JWT subjects for service tokens, and the `X-Saga-Caller` header value. Adopted now; SPIRE deployment is later.
7. **No header-trusted identity** — `x-user-id` and `x-organization-id` headers are *never* trusted as identity. They may be *requested* values that the system verifies against the JWT-derived truth.

## What this directory does NOT define

- Runtime crypto (DPoP key generation, mTLS cert distribution, JWT signing key plumbing) — those live in their service repos and follow-up packages.
- IdP choice — ADR-level recommendation is Cognito (see plan.md appendix); the contracts package is IdP-agnostic.
- Specific FGA tuples — only the model types and relations live here; tuples reflect data state and live wherever the sync worker writes them.
- Audit storage backend — only the event *shape* lives here.

This separation means the seams here remain stable while implementations evolve.

## How to propose a change

1. Open a draft ADR PR against this directory (numbered next).
2. Tag the auth working group on the PR.
3. ADRs are *Accepted* by review consensus; *Superseded* by a later ADR that links back.
4. Once accepted, update `packages/core/auth-contracts/` to match.

ADRs are short. If yours is over a page, it's probably two ADRs.
