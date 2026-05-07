# ADR 0006 — SPIFFE ID format for service identity

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 5 (Service-to-service authentication)](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#5-service-to-service-authentication)

## Context

The fleet needs a consistent way to name workloads (services, workers, batch jobs). The name appears in:

- mTLS certificate Subject Alternative Names (SANs) — ECS-to-ECS calls
- JWT `sub` claim for service tokens
- The `X-Saga-Caller` header value (ADR 0002)
- Audit events (ADR 0004)
- OpenFGA tuples that grant service-level access

Different formats in different places make cross-system correlation painful. We need one format, adopted everywhere, that survives a future migration to SPIFFE/SPIRE for workload attestation.

## Decision

### Format

Saga workload identifiers MUST follow the SPIFFE URI format:

```
spiffe://saga.<env>/<service>[/<component>]
```

Where:

- `saga.<env>` is the **trust domain** — `saga.dev`, `saga.staging`, `saga.prod`. Tied 1:1 with environments; cross-env identifiers are forbidden.
- `<service>` is the deployable unit name in kebab-case. Example: `iam-api`, `programs-api`, `rostering-events-relay`.
- `<component>` is optional, used when one deployable contains multiple distinct workload identities (e.g., a worker pool inside an API service).

### Examples

| Workload | SPIFFE ID |
|---|---|
| iam-api in dev | `spiffe://saga.dev/iam-api` |
| programs-api in prod | `spiffe://saga.prod/programs-api` |
| iam-api's outbox relay (separate workload identity within iam-api) | `spiffe://saga.prod/iam-api/outbox-relay` |
| FGA tuple sync worker (sub-workload of iam-api) | `spiffe://saga.prod/iam-api/fga-sync` |

### User identifiers (related)

Users are also SPIFFE-formatted to keep one identity convention across the fleet:

```
spiffe://saga.<env>/user/<uuid>
```

This appears in JWT `sub` for user tokens (ADR 0001). Users are not workloads in the SPIFFE sense, but using the same scheme keeps audit logs and tuples uniform.

### Where it appears

- **mTLS cert SAN** — ECS task certs include the workload's SPIFFE ID as a `URI` SAN entry. Receiving services parse it.
- **`X-Saga-Caller` header** — exact SPIFFE ID string.
- **JWT `sub`** — for service tokens, the calling workload's SPIFFE ID.
- **JWT `aud`** — the receiving workload's SPIFFE ID.
- **Audit events** — `caller.spiffeId` and `subject.sub`.
- **OpenFGA tuples** — service-level grants use SPIFFE IDs as user-equivalent subjects.

### Validation

`@saga-ed/soa-auth-contracts` exports two parsers:

1. **`parseSpiffeId(input)`** — structural validation. Accepts only
   `spiffe://saga.{dev|staging|prod}/...` URIs, splits service and
   optional component, rejects empty/wildcarded components. Does **not**
   compare the trust domain to the active environment — that's a
   runtime concern the caller knows about, not a parse concern.
2. **`spiffeIdForEnv(env)`** — schema factory bound to a specific env.
   Use this at trust boundaries (mTLS handler, JWT verifier, audit
   emitter) where cross-env tokens (a dev cert reaching prod) MUST be
   rejected. Callers that use `parseSpiffeId` directly are responsible
   for re-checking the env match if they care.

## Consequences

**Positive:**
- One identifier format everywhere — easier debugging, log search, audit query.
- SPIRE migration is a config change, not a rename: certs already carry the right SAN format.
- Cross-env mistakes (a dev cert reaching a prod service) are caught at parse time.

**Negative:**
- Cert provisioning must include the SPIFFE URI SAN — a small addition to existing PKI templates.
- The `spiffe://` prefix is verbose in logs; mitigated by uniform formatting (everyone reads it the same).

## Alternatives considered

- **Bare service names (`iam-api`):** rejected. No environment scoping; cross-env mistakes invisible until production damage.
- **AWS ARN-style:** rejected. AWS-coupling makes Lambda + ECS uniformity awkward; not adopted broadly outside AWS.
- **DNS names (`iam-api.prod.saga.internal`):** rejected. DNS conflates network address with identity; an attacker controlling DNS shouldn't get caller identity.

## References

- SPIFFE specification — https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/
- SPIRE — reference implementation we may adopt later
- ADR 0001 — JWT claim shape (`sub`, `aud` use this format)
- ADR 0002 — Two-headers invariant (`X-Saga-Caller` carries this format)
