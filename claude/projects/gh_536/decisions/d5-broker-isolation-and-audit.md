# d5 — Broker isolation and the dev binding audit

RESOLVED — 2026-10-28

User ruling: "As recommended - approve dev broker credentials". A1: read-only live
binding audit of the dev broker before Gate G, with the existing dev broker credential
read in-process (approved). B1: the receiver uses the existing shared dev broker user.

## Context

[d1](d1-event-stats-routing.md) settled routing: reporters publish
`observability.event_stats.reported` on their own existing exchange, Vishnu owns
separate telemetry queues, and no per-service broker users are introduced. Two
things remain before reporters are enabled:

1. **Proof that no business consumer receives reports.** The handoff requires an
   audit of the **actual dev broker** (Amazon MQ `shared-dev-mq`, single-instance
   RabbitMQ), because the synthetic audit proves nothing about cloud bindings.
2. **Which broker credential the Vishnu receiver uses.**

### Source audit (done 2026-10-28, `origin/main` of every Node repo under `~/dev`)

- `iam.events`, `programs.events` and `scheduling.events` are all **topic** exchanges
  (none is fanout). Previews are renamed `<name>.<tag>`.
- Every consumer binding uses a family prefix (`iam.user.*`, `programs.period.*`,
  `scheduling.slot.*`, and so on) or a literal key. This covers authz-api,
  authz-sync, coach-api, programs-api, scheduling-api and sessions-api. **None** uses
  `#`, a three-word wildcard, or an `observability.` prefix, so none matches the
  report key.
- `@saga-ed/soa-event-consumer` binds only the exact `{exchange, routingKey}` pairs it
  is given (`consumer.ts:481`). Its only `#` binding is DLQ queue → DLQ exchange.
- If a report did reach a business queue (say, a future `#` binding), no handler is
  registered for it, so it is nacked without requeue as `ConsumerVersionMismatchError`
  and lands in that consumer's DLQ (`consumer.ts:600–616, 741`). The result is an error
  log and a DLQ entry, with no effect on business handling.
- Not covered: bindings made by hand, from broker definitions, or by shovels;
  unpushed branches; non-Node consumers.

## Decision A — the live audit

1. **Read-only live audit before the first reporter is enabled (Gate G).** List
   bindings on the three exchanges through the broker's management API, using the
   existing dev broker credential read in-process (never printed or stored), and
   record the result here.
   - Closes the only gap the source audit leaves. Needs one credential read beyond
     the Observer role.
2. **Rely on the source audit alone.**
   - No credential access. Leaves hand-made bindings unchecked, against the
     handoff's explicit requirement.

## Decision B — the receiver's broker credential

1. **The existing shared dev broker user**, as d1 ruled (no per-service users in
   this initiative).
   - No broker admin work. Vishnu could technically publish to business exchanges,
     the same as every service on that user today.
2. **A Vishnu-only broker user** (read its own queues, no writes to business exchanges).
   - Real permission isolation, but it overturns d1 and makes Vishnu the first
     per-service user ahead of the fleet migration.

## Recommendation

**A1 and B1.** The source audit makes a stray match unlikely, and even a stray match
only produces DLQ entries, but a live check is cheap and the handoff asks for it.
Run it read-only before Gate G, not before Gate D, because the receiver's own
exact-key binding can't affect anyone. Keep the shared credential per d1, and leave
permission isolation to the fleet migration. Confidence: high.

If you choose A1, the audit needs your explicit OK to read the dev broker
credential, since it is beyond the Observer role.

## Related artifacts

- `/home/skelly/dev/rostering/packages/core/iam-events/src/index.ts` (line 41, `IAM_EXCHANGE`)
- `/home/skelly/dev/program-hub/packages/node/programs-events/src/index.ts` (line 152)
- `/home/skelly/dev/program-hub/packages/node/scheduling-events/src/index.ts` (line 66)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/packages/node/event-consumer/src/consumer.ts` (lines 463–489, 600–616, 741)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/telemetry/event-stats-receiver.ts` (line 96)
- [d1](d1-event-stats-routing.md), [d3](d3-mq-scope-model.md), [d4](d4-receiver-store-and-colour-ownership.md)
