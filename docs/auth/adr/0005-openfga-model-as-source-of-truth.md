# ADR 0005 — OpenFGA model as source of truth

**Status:** Accepted
**Date:** 2026-05-07
**Concept primer:** [`saga-dash/docs/auth/concepts.md` § 6 (Authorization models) and § 7 (OpenFGA and Zanzibar)](https://github.com/saga-ed/saga-dash/blob/main/docs/auth/concepts.md#6-authorization-models)

## Context

Saga's authorization landscape today is RBAC inside rostering with coarse organization-scoping in resource services. As more services join the fleet (program-hub, qboard, rtsm) the gaps surface:

- "List every program a tutor has access to" is RBAC-hostile (n×m role lookups).
- District → school → cohort → student is a graph; representing it as flat roles requires a role per scope.
- Per-resource permissions (this specific program, this specific room) exhaust the role table.

OpenFGA (CNCF, Zanzibar-faithful) is the right shape for this hierarchy. The decision now is *how* it integrates: who owns the model, who writes tuples, where the source-of-truth lives.

## Decision

### The `.fga` DSL is the source of truth

The model is defined in OpenFGA's DSL (`.fga` files), versioned in `packages/core/saga-authz-model/` in this repo. No service defines tuple types in code; all references go through generated TypeScript types or the FGA SDK.

Changes to the model are PRs against this directory, reviewed by the auth working group. Backwards-incompatible model changes use OpenFGA's authorization model versioning (each `WriteAuthorizationModel` returns an immutable `authorization_model_id`); old IDs continue to serve in-flight requests.

### Tuple writes flow through a sync worker, not services

Application services never write tuples directly. A dedicated sync worker (in rostering or a dedicated service) subscribes to `iam.*` events from rostering and translates them to tuple writes. This keeps:

- The model authoritative (no service-side drift).
- Idempotency manageable (the sync worker dedupes).
- Audit clarity (one path for tuple changes — easier to investigate divergence).

Application services only call `check`, `list-objects`, `list-relations`. They do not call `write`, `delete`, `expand`.

### Two-layer namespace split

Per Saga IaC plugin convention:

- **Identity types** — `tenant`, `user`, `group`, `role`. Define *who* can be granted access.
- **Resource types** — `program`, `school`, `cohort`, `session`, `room`, `whiteboard`, `enrollment`. Define *what* access is granted to.

Identity-side tuples come from rostering events. Resource-side tuples come from the resource owner's events (program-hub for programs, etc.) — but *only* via the same sync worker process, fanned out by event type.

### Tenant binding is mandatory

Every check is tenant-scoped. The tenant is part of the resource ID format (`program:district:42:program:7`) or expressed as a parent-of relation (`(tenant:district:42, parent, program:7)`). Cross-tenant checks fail by construction.

### Model lives in `packages/core/saga-authz-model/`

- `model.fga` — the DSL source
- `src/types.ts` — hand-maintained TypeScript constants mirroring the
  DSL types and relations (`FGA_TYPES`, `FgaRelationsByType`,
  `FgaRelation<T>`)
- `src/__tests__/model-fga.unit.test.ts` — CI guard that diffs the
  `.fga` file against `src/types.ts`; build fails on drift
- `README.md` — how to read it, how to extend it (PRs MUST update both
  files in lockstep)

The TS mirror is hand-maintained, not codegen'd. A future codegen pass
can replace `src/types.ts` without changing the package's public API
(`FgaType`, `FgaRelation<T>`, `tupleKey<T>` are stable).

The package exports tuple-key builder helpers but does not bundle the
FGA SDK — services depend on `@openfga/sdk` directly when they need
runtime checks.

### Today vs tomorrow

| Phase | What ships |
|---|---|
| **Today (P1)** | `model.fga` committed, types generated. No FGA store deployed. Services do not yet call `check`. |
| **Later** | FGA store deployed, sync worker built, services adopt `authz.check` resource-by-resource alongside the existing RBAC checks. Once parity is proven, RBAC is removed. |

This decoupling means the *model* is reviewed, frozen, and ready before any service depends on it at runtime — minimizing rework.

## Consequences

**Positive:**
- Single canonical authorization model across the fleet.
- Reverse-index queries ("what can user X see?") become tractable.
- Clean separation between *model* (here) and *data* (rostering / resource services).
- Future additions (new resource types, new relations) are local PRs against this directory.

**Negative:**
- Two-step writes (event → sync worker → tuple) add latency for grant changes; mitigated by event speed and ≤30s caching.
- Operational complexity — running an FGA store is a new system (when it deploys later).

## Alternatives considered

- **Define tuple types in service code:** rejected. Drift between services would be inevitable; central review impossible.
- **Services write tuples directly on grant changes:** rejected. Multiple writers leads to inconsistency and audit complexity.
- **Cedar instead of OpenFGA:** rejected for the primary use case. Cedar is great for policy rules; ReBAC for resource hierarchies. The plan reserves the right to add Cedar for non-resource policy later.
- **Stay with RBAC + ABAC:** rejected. Concept primer § 6 details why this hits a wall as the resource graph grows.

## References

- OpenFGA documentation — https://openfga.dev/
- Zanzibar paper — Pang et al., 2019
- Concept primer § 7 — full background on tuples, types, and relations
- ADR 0001 — JWT shape (`saga.tenant` claim feeds tenant-scoped checks)
