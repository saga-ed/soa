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

A single service — **authz-api**, the PDP (rostering north star §3; evolves out of iam-api's
personas sector and absorbs the staff store) — is the only holder of FGA credentials. Application
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

- **Ownership partition**: each *directly-assignable* tuple type (`type#relation` that can carry
  stored tuples — computed relations have no writer and are out of scope) is registered to exactly
  one producing domain. The partition registry lives beside the model in
  `packages/core/saga-authz-model/`; CI fails if a directly-assignable relation in `model.fga` has
  zero or multiple registered owners, and the ingest API rejects writes outside the caller's
  partition at runtime.
- **Ordering**: tombstones for out-of-order remove/add (the exact guard the local projections
  already use), so replays and skew cannot resurrect a removed fact.
- **Backfill**: registering a fact type requires a snapshot replay path; a partition is not "live"
  until its initial state is loaded.
- **Reconciliation**: periodic source-diff per partition (producer exposes a snapshot; the PDP
  diffs and repairs), so a single lost event cannot linger forever.

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

## Consequences

**Positive:** the revocation-resurrection/backfill/reconcile failure class is closed by
construction for delegation facts and closed once-centrally for domain facts; domain teams own
their facts without owning FGA plumbing; one audit path per fact class; one thing to monitor;
0005's anti-drift and check-only invariants preserved exactly.

**Negative:** the PDP is a new critical-path service (its availability posture — distinct
503-class signal, SDK caching, never masked NOT_FOUND — is part of the north star and must ship
with step 1); the ingest API is real engineering (it replaces N workers, but someone builds it);
domains must expose snapshot endpoints for reconciliation.

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
