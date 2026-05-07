# @saga-ed/soa-auth-contracts

Canonical wire shapes for fleet authentication and authorization. Zod schemas, type definitions, and parsers — runtime-agnostic and crypto-free.

## What this package owns

| Module | Owns | ADR |
|---|---|---|
| `spiffe.ts` | SPIFFE ID format (`spiffe://saga.<env>/<service>[/<component>]`) | [0006](../../../docs/auth/adr/0006-spiffe-id-format.md) |
| `jwt-claims.ts` | Canonical JWT claim shape (`iss`, `aud`, `sub`, `saga.tenant`, `saga.session`, `cnf`) | [0001](../../../docs/auth/adr/0001-jwt-claim-shape.md) |
| `two-headers.ts` | `X-Saga-Caller` + `Authorization` headers; structural parser; mode flag | [0002](../../../docs/auth/adr/0002-two-headers-invariant.md) |
| `audit-event.ts` | `audit.decision.v1` event schema; forbidden-field detector | [0004](../../../docs/auth/adr/0004-audit-event-shape.md) |

## What this package does NOT own

- JWT signing/verification (no `jose`, no key plumbing)
- DPoP proof generation
- mTLS cert verification
- HMAC computation for event signatures
- The audit log writer (logger today, Postgres later)
- The OpenFGA model itself (sibling package `@saga-ed/saga-authz-model`)

These belong in downstream packages that import these schemas.

## Usage

```ts
import {
    parseTwoHeaders,
    CanonicalJwtClaimsSchema,
    AuditDecisionEventSchema,
    parseSpiffeId,
} from '@saga-ed/soa-auth-contracts';

// Structural parse of incoming headers
const { status, callerSpiffeId, bearerToken } = parseTwoHeaders(req.headers);

// Validate decoded JWT payload
const claims = CanonicalJwtClaimsSchema.parse(decoded);

// Validate an audit event before emit
const event = AuditDecisionEventSchema.parse({ ... });
```

## Versioning

This package follows the convention established by `@saga-ed/soa-event-envelope`: the v1 wire shape is treated as the contract; any change to the v1 shape requires coordinated migration. New shapes ship as `audit.decision.v2`, etc., side by side.
