# ADR 0006 — Authorization PDP and fact-ingest discipline

**Status:** Proposed
**Date:** 2026-07-13
**Amends:** ADR 0005 — the "tuple writes flow through a sync worker" mechanism and the
single-process reading of it. ADR 0005's model-as-source-of-truth, check-only services, two-layer
namespace, and mandatory tenant binding are **unchanged and restated here**.
**Companion:** rostering `claude/authz_north_star.md` (the full architecture); program-hub
sessions-gating migration design (the first consumer).

## Context

ADR 0005 (P1) committed the fleet to OpenFGA with two write-side rules: application services never
write tuples, and all tuple writes flow through "a dedicated sync worker" fed by events. Two things
have changed since:

1. **Design review found the projection topology unsafe for grant facts.** An async
   event-projected writer, per the existing reference implementation, swallows
   delete-of-absent-tuple as idempotent replay — so an out-of-order `removed`→`added` pair
   silently **resurrects a revoked grant**. Add missing backfill (pre-existing facts never become
   tuples) and no reconciliation (one lost removal = a permanently lingering grant), and
   "at-least-once + idempotent = effectively-once" is simply false for add/remove pairs. These are
   not implementation bugs to patch per-worker; they are the cost of *projecting your own
   authoritative facts into a second brain asynchronously*.
2. **Resource facts genuinely belong to other domains.** program-hub (the first runtime consumer)
   must contribute program-scope edges, pod tutorship, and session-host facts that IAM does not
   know. 0005 anticipated this ("resource tuples come from the resource owner's events") but
   routed everything through one worker process, coupling it to every domain's event schemas.

The system is pre-traffic. This is the moment to fix the write-side topology rather than harden N
copies of it.

## Decision

### 1. One Authorization PDP owns the store

A single service — **authz-api**, the PDP (rostering north star §3; a **new dedicated service**
per the 2026-07-13 deployment-shape decision, absorbing the personas authority from iam-api and
the staff store) — is the only holder of FGA credentials. Application
services call the PDP/SDK (`check` / `capabilities` / `values` / `explain`); they never talk to
FGA directly and never write tuples (0005 rule, unchanged). One fleet store per environment —
cross-domain traversal (program → group scope → grant → user) requires one graph.

### 2. Delegation facts are authored in, not projected in

Facts whose authority *is* the authorization system — role-bundle definitions, grant/revoke of
bundles at scopes — are written to the ledger and the FGA store **synchronously in the PDP's own
request path** (Q7 → Q1 visible within SDK cache TTL). No event hop, no projection lag, no
backfill or resurrection class *for the facts where a lingering grant is a security incident*.

### 3. Domain facts arrive through ONE ingest implementation

Facts whose authority lives in another domain (program→scope edges, pod tutorship, session-host —
from `programs.*` / `scheduling.*` / `sessions.*`; identity/staff facts from `iam.*`) arrive as
events through the PDP's **ingest API**, which centrally implements, once:

Transport is the fleet's existing event mesh — the owning domain's transactional outbox
(`@saga-ed/soa-event-outbox` relay → RabbitMQ topic exchange, e.g. `iam.events`) consumed via
`@saga-ed/soa-event-consumer`, whose per-message transaction inserts into `consumed_events`
(composite PK `consumer_name, event_id`) atomically with the projection write. The ingest API is
a disciplined *consumer* of that mesh, not a parallel transport.

- **Ownership partition**: each *directly-assignable* tuple type (`type#relation` that can carry
  stored tuples — computed relations have no writer and are out of scope) is registered to exactly
  one producing domain. The partition registry lives beside the model in
  `packages/core/saga-authz-model/`; CI fails if a directly-assignable relation in `model.fga` has
  zero or multiple registered owners, and the ingest API rejects writes outside the caller's
  partition at runtime.
- **Ordering**: tombstones for out-of-order remove/add (the exact guard the local projections
  already use), so replays and skew cannot resurrect a removed fact.
- **Backfill**: registering a fact type requires a snapshot replay path; a partition is not "live"
  until its initial state is loaded. The preferred mechanism is **outbox re-emit** — the producer
  re-emits events for existing rows through the same bus, so backfill exercises the one code path
  consumers already handle (idempotent upserts with monotonic source-timestamp guards) instead of
  a second bulk-read API. Snapshot endpoints are the fallback where re-emit is too heavy.
- **Reconciliation**: periodic source-diff per partition (producer re-emits or exposes a snapshot;
  the PDP diffs and repairs), so a single lost event cannot linger forever.

Contextual tuples in checks are **not writes** and don't violate the partition — but any relation
intended to be supplied contextually must be marked so in the partition registry, so a relation is
never both stored-and-owned and contextually-injected without that being an explicit, reviewed fact.

### 4. Restated from 0005 (still binding)

- The `.fga` DSL in `packages/core/saga-authz-model/` is the model source of truth; non-additive
  changes mint a new model id.
- **Tenant binding is mandatory**: every resource type keeps a parent path to its tenant; the
  staff plane (`saga_platform`/`staff_org`) keeps zero edges into tenant resource trees (SEC-CRIT-2).
- One object identity per real-world entity (a rostering group is `group:<id>` — no parallel
  scope-type shadows).

### 5. The ADR-0005 worker converges into this design — it is not removed on merge

The concrete instance of "the ADR-0005 sync worker" is the **live** `authz-sync` service
(rostering `apps/node/authz-sync`, in dev + prod today), the sole writer of the shared
`/openfga/<env>/main` store, consumed only by iam-api's staff-plane gates. This ADR *supersedes its
mechanism* but does not retire the running service: its staff-role facts become **authored-in
delegation grants** (§2) and its group-membership / district-org facts become **ingest-API domain
facts** (§3), exactly the two paths above. The full sunset criteria — the five iam-api gates to
re-point, staff-plane parity, no-other-reader verification, and the SEC-CRIT-2 re-assertion — live
in the north star's **§8 (single source of truth; not duplicated here)**. Until those hold,
`authz-sync` is a *named transitional coexistence*, not an accepted second authz brain.

## Consequences

**Positive:** the revocation-resurrection/backfill/reconcile failure class is closed by
construction for delegation facts and closed once-centrally for domain facts; domain teams own
their facts without owning FGA plumbing; one audit path per fact class; one thing to monitor;
0005's anti-drift and check-only invariants preserved exactly.

**Negative:** the PDP is a new critical-path service (its availability posture — distinct
503-class signal, SDK caching, never masked NOT_FOUND — is part of the north star and must ship
with step 1); the ingest API is real engineering (it replaces N workers, but someone builds it);
producers must support re-emit (or expose snapshot endpoints) for backfill and reconciliation.

**First realization (2026-07-16):** the `iam.*` projection consumer inside authz-api — step 1's
façade serves capabilities/values from a local projection fed by iam-api's outbox, with re-emit
backfill. An earlier step-1 draft instead read iam_db directly through a read-only role; that
cross-service database read violated this ADR's §3 (and the mesh's projection rule) and is
removed. It also surfaced one producer-side coverage gap: persona policy values had no event,
closed additively as `iam.persona_policies.upserted.v1`.

## Alternatives considered

- **N domain-owned writers, each writing FGA directly** (an earlier draft of this ADR): rejected —
  every writer re-implements ordering/backfill/reconcile, and review showed the reference
  implementation already carries a revocation-resurrection bug. Centralize the discipline instead.
- **One worker consuming all domains' events** (0005 literal): rejected — couples one process to
  every domain's schemas and leaves the projection-lag problem for delegation facts unsolved.
- **Keep grants projected async, harden with tombstones everywhere**: rejected — hardening N
  copies of the hard part, and revocation still waits on an event pipeline. Authoring-in removes
  the class.

## References

- ADR 0005 — OpenFGA model as source of truth (amended)
- rostering `claude/authz_north_star.md` — full architecture, budgets, semantics decisions
- rostering `scripts/fga/prototype/` — runnable model + evidence
- program-hub sessions-gating migration design — first consumer
