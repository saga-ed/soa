# Plan 15 — `podAssignments.upsert` vs slot-projection lag (program-hub#320)

**Status: OPTIONS FOR REVIEW** — feedback requested from Nathan + Kevin on
program-hub#320 before implementation.

## The race, precisely

`programs-api` validates the slot id against its **local projection**:

```ts
// apps/node/programs-api/src/services/pod-assignments.service.ts:102
const slot = await tx.slotProjection.findUnique({ where: { id: body.slotId } });
if (!slot || slot.deletedAt) throw slotNotFound(body.slotId);
```

The projection is fed asynchronously by `event-handlers/slot-projection.ts`
(`slot.created`). So a client that creates a slot in scheduling-api (directly,
or transitively via a rotation remint) and immediately calls
`podAssignments.upsert` gets **NOT_FOUND for an id that is committed and
real** — indistinguishable from a genuinely bad id. Callers can only
blind-retry.

**Observed twice** by the scheduling-topology e2e flow (soa#221): at initial
flow bring-up (spec grew a retry loop), and again 2026-07-06 *after* the
#318/#319 fixes landed — the retry window lost the race once and a rerun
passed. It is now that flow's dominant flake, and every future
"create slot → assign pods" client inherits the same burden.

Non-goal: removing the projection itself. The async read-model is by design;
the problem is the **contract** during the lag window.

## Options

### A — Typed retryable rejection: `SLOT_NOT_PROJECTED`  *(recommended)*

When the slot id misses the projection, throw a distinct, documented code
(tRPC `CONFLICT`-family, e.g. `SLOT_NOT_PROJECTED`) instead of the generic
NOT_FOUND. Semantics: "well-formed id, not visible to this service *yet* —
retry with backoff; treat as NOT_FOUND only after your budget."

- **Pros:** ~20-line service change + tests; no schema, no new state; makes the
  eventual consistency *legible* at the API boundary; e2e + UI retries become
  targeted (retry `SLOT_NOT_PROJECTED` only) instead of blanket.
- **Cons:** clients still poll (bounded); a forever-bad UUID also reads as
  "not projected" until the caller's budget expires (acceptable: it then
  converges to the same terminal NOT_FOUND behavior as today).
- **Honesty note:** the server genuinely cannot distinguish "not yet" from
  "never" without asking scheduling-api — this option prices that in rather
  than hiding it.

### B — Deferred apply (pending assignment, consumer-reconciled)

Accept the upsert optimistically: write a `pending_pod_assignment` row keyed
by `(podId, slotId)`; the `slot.created` consumer reconciles it into a real
assignment when the projection lands (mirrors the existing
`event-handlers/adhoc-pod-assignment.ts` pattern, which already does
event-driven assignment creation for synthetic slots).

- **Pros:** fire-and-forget for clients — the race disappears from every
  caller's contract; consistent with the house event-driven style.
- **Cons:** new table + lifecycle (TTL/cleanup for slots that never arrive);
  the upsert's response changes shape ("accepted-pending" vs the current
  `WirePodAssignment` — a wire contract change); read-your-write surprises
  (assignment invisible in `listForSlot` until reconciliation); meaningfully
  more moving parts for a lag window that is normally sub-second.

### C — Pull-through validation (synchronous S2S fallback)

On projection miss, programs-api asks scheduling-api directly
(`slots.get`-style S2S); if the slot exists, eagerly insert the projection row
(idempotent with the consumer's later write) and proceed.

- **Pros:** closes the race synchronously — no client changes, no pending
  state; projection stays authoritative for reads.
- **Cons:** introduces a runtime S2S dependency + availability coupling on the
  WRITE path of programs-api (today it's fully decoupled); needs care to keep
  the eager insert idempotent vs the consumer; the failure matrix grows
  (scheduling-api down ⇒ upserts of valid new slots fail differently).

### D — Spec-side only (status quo, instrumented)

Widen the e2e retry window; no product change.

- **Pros:** zero risk.
- **Cons:** the contract wart stays for every real client; the flow keeps a
  workaround the other two findings just got rid of. Listed for completeness,
  not proposed.

## Recommendation

**A now** (small, honest, unblocks intelligent retries everywhere), with **B
or C as a follow-up** only if pending-window UX ever matters for a real user
flow (e.g. the pods wizard doing bulk assigns against freshly-minted slots).
A also composes with C later: the typed code becomes the fallback if the S2S
probe itself fails.

## Implementation sketch (Option A)

1. `pod-assignments.service.ts`: split the guard — projection miss (no row at
   all) ⇒ `slotNotProjected(slotId)`; `deletedAt` set ⇒ keep `slotNotFound`
   (a deleted slot is a real terminal answer).
2. `throwServiceError` mapping + wire error code; document the retry contract
   in the router JSDoc.
3. Tests: unit (both guard halves), integration (upsert during withheld
   `slot.created` → typed code; after delivery → success — reuse the
   remint-race integration harness from #319).
4. e2e: topology spec's retry loop narrows to `SLOT_NOT_PROJECTED`-only with a
   hard cap; flake disappears or fails loudly with the right diagnosis.
5. Sweep other projection-guarded writers in programs-api for the same
   pattern (pods? overrides?) — same treatment if found, separate commit.

**Size:** S (A alone). **Acceptance:** topology flow N≥5 consecutive green on
slot 1 with the narrowed retry; the typed code visible in one forced-lag
integration test.
