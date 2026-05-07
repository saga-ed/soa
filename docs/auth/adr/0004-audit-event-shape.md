# ADR 0004 — Audit event shape (`audit.decision.v1`)

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 10 (Audit logging)](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#10-audit-logging)

## Context

Audit logs serve three distinct audiences (forensics, compliance, anomaly detection — see concept primer § 10). They must be:

- **Structured** so they can be queried and aggregated.
- **Stable** across services so cross-service investigation works.
- **Independent of storage** so the underlying store can evolve (today: structured logs; tomorrow: hash-chained Postgres + S3 Object Lock) without callers changing.

Saga today has *some* audit data (the `actorFromContext` decorator on rostering tRPC mutations) but no shared schema and no consistent emission across services.

## Decision

Define a single canonical audit event type, `audit.decision.v1`, with this shape:

```ts
{
  // Versioning
  schemaVersion: "v1",
  eventType: "authn.login" | "authn.logout" | "authn.refresh" | "authn.token_exchange"
           | "authz.check" | "authz.deny"
           | "mutation.create" | "mutation.update" | "mutation.delete"
           | "admin.role_grant" | "admin.role_revoke" | "admin.config_change",

  // Identity (both required when applicable)
  caller: {
    spiffeId: string,        // service workload, ADR 0006
  } | null,                  // null only for end-user direct calls (e.g., browser → API)
  subject: {
    sub: string,             // SPIFFE-formatted user, ADR 0001
    tenantId: string | null, // saga.tenant claim
    sessionJti: string | null,
    tokenJti: string | null, // null on authn.login (subject known
                             // before token issued); required by
                             // convention for post-login events but
                             // not enforced by the schema (too brittle
                             // to drop an audit row over).
  } | null,                  // null only for unauthenticated events (e.g., login-failure)

  // What happened
  resource: {
    type: string,            // e.g., "program", "school"
    id: string,
    tenantId: string | null,
  } | null,
  action: string,            // domain action, e.g., "view", "delete", "join"
  decision: "allow" | "deny",
  reason: string | null,     // structured code: "no_tuple", "expired_token", "tenant_mismatch", ...

  // Authz tracing (for ReBAC checks)
  fgaCheck: {
    relation: string,
    object: string,           // type:id form
    consultedTuples: string[] // optional, for forensic depth; may be omitted in high-volume paths
  } | null,

  // Timing & correlation
  occurredAt: string,         // ISO 8601 with offset
  correlationId: string,      // OTel traceId or upstream-supplied
  causationId: string | null, // event that caused this one

  // Operational
  service: string,            // emitting service's SPIFFE ID
  env: "dev" | "staging" | "prod",
}
```

### What MUST be emitted

Every service that participates in fleet auth emits `audit.decision.v1` for:

- Authentication: login (success/failure), logout, refresh, token-exchange
- Authorization: every check that returns deny; every check on sensitive resources (configurable per service)
- Mutations: every state-changing operation
- Admin actions: role grants/revokes, group membership changes, configuration changes

### What MUST NOT appear in audit events

- Bearer tokens, refresh tokens, DPoP proofs (only `jti` is logged)
- Passwords, MFA codes, recovery secrets
- Full PII bodies (names, emails) — store IDs only; reconstruct PII from the PII-DB on-demand for compliance queries
- Raw request/response bodies

### Storage today vs tomorrow

| Phase | Writer | Storage |
|---|---|---|
| **Today** | `@saga-ed/soa-audit.emit()` writes via `@saga-ed/soa-logger` to a dedicated `audit` channel | App log aggregation (e.g., CloudWatch, Datadog) |
| **Later** | Same `emit()` API, swapped writer | Hash-chained Postgres `audit_event` table; daily KMS-signed Merkle root → S3 Object Lock (compliance mode), 7-year retention |

The shape is the contract; the storage is the implementation. Callers do not change between phases.

### Querying

Standard query interface (offered by the audit package once Postgres backend lands):

- `byActor(sub, since, until)` — every action by a user
- `byResource(type, id, since, until)` — every action on a resource
- `denials(since, until, env)` — all `decision = "deny"` events for anomaly review
- `byCorrelationId(traceId)` — every audit event tied to a single request

## Consequences

**Positive:**
- Stable shape lets storage evolve without breaking callers or queries.
- Cross-service investigation (forensics) works because every emit conforms.
- Schema-enforced "what NOT to log" prevents accidental PII leakage.

**Negative:**
- Adds an emit call to every mutation/check; mitigated by tRPC middleware.
- Schema changes are coordinated across services; mitigated by `schemaVersion` field — `v2` would coexist with `v1`.

## Alternatives considered

- **Per-service ad-hoc audit:** rejected. We have this today and it does not let auditors answer cross-service questions.
- **Use OTel logs only:** rejected. OTel is great for tracing but is not designed as a tamper-evident audit store. Audit gets its own channel even if it rides OTel transport today.
- **CloudTrail-only (AWS-managed):** rejected. CloudTrail captures AWS-API actions, not application authz decisions. We need both.

## References

- ADR 0001, 0002 — identity fields
- ADR 0006 — SPIFFE ID format
- NIST SP 800-92 — Guide to Computer Security Log Management
- FERPA / NY §2-d audit-log expectations (concept primer § 14)
