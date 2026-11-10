# d6 — Mapping report and service identities to hosted Vishnu nodes

RESOLVED — 2026-10-28

User rulings: "Add alias now" (B2) and "As recommended" (A1). A1: keep the literal
reporter allowlist and attach MQ stats to the reporting service node only, with no
inferred MQ edges. B2: alias Datadog `qboard_connectv3` to the declared `connectv3`
node now. Implemented as `apmServiceAliases` (`declared-topology.ts`), applied by
`canonicalApmServices` (`cloud-mesh.ts`) to the snapshot served by both the `mesh`
and `datadog` routes, so edges and per-node signals agree. Covered by
`tests/cloud-mesh.test.ts`.

## Context

Hosted Vishnu's graph nodes are Datadog APM service names, plus source-declared
connections (`apps/node/vishnu-api/src/declared-topology.ts`). MQ reports must land
on the right node without guessing. The handoff also warns that declared links are
not traffic, and that report counts cannot show queue backlog, broker confirmation,
end-to-end success or causal edge latency.

What exists today:

- **Reporter allowlist.** `REPORTERS` (`event-stats-store.ts:14`) maps
  `iam-api → iam.events`, `programs-api → programs.events` and
  `scheduling-api → scheduling.events`. A report is accepted only when its
  `identity.service` is one of these and it arrived on that service's own exchange.
  Anything else is rejected as `scope`.
- **UI attachment.** `serviceStats` (`apps/web/vishnu/src/lib/graph/event-stats.ts:37`)
  attaches a report only to the node whose service equals `identity.service`. Producer
  counters and per-queue consumer counters are shown inside that node. No queue nodes
  or MQ edges are drawn.

Checked against Datadog APM, `env:dev`, last 24h (2026-10-28):

| Node ID (Vishnu) | Datadog `service` | Spans |
|---|---|---|
| `iam-api` | `iam-api` | 20,408 |
| `programs-api` | `programs-api` | 5,246 |
| `scheduling-api` | `scheduling-api` | 20,337 |
| `connectv3-api` | `connectv3-api` | 49,441 |
| `saga_dash` | `saga_dash` | 724 |
| `connectv3` (declared web app) | none; nearest is `qboard_connectv3` | 80 |

## Decision A — how MQ reports map to nodes

1. **Keep the literal allowlist and attach to the reporting service only.** Report
   `service` must equal the Datadog service name (confirmed above for all three
   reporters). Queues and consumers are listed inside the service node. No edges are
   inferred from counts. A new reporter requires an explicit `REPORTERS` entry, so
   unknown reporters fail closed.
   - No code change. Honest about what counts can and cannot show.
2. **Draw publisher → consumer edges from broker bindings and report counts.**
   - A richer picture, but it presents counts as traffic between services, which the
     handoff rules out, and depends on live binding discovery.
3. **Queues as first-class graph nodes.**
   - Shows topology more literally, but adds UI work with no dev need yet.

## Decision B — the `connectv3` web app vs Datadog `qboard_connectv3`

1. **Leave `connectv3` as a declaration-only node for now.** Record the possible
   alias, and add it explicitly only after the qboard owners confirm that
   `qboard_connectv3` is the Connect web app's service.
   - No guessing. The node keeps its declared edges and simply shows no APM data.
2. **Alias `qboard_connectv3 → connectv3` now.**
   - Joins the APM data immediately, but rests on a name match and a small span count.

## Recommendation

**A1 and B1.** A1 is already implemented and verified against real dev service names.
It keeps MQ stats on the node that produced them and draws nothing the data can't
support. B1 avoids the guessed mapping the handoff warns about; the alias is a one-line
`applicationLabels`/mapping change once confirmed. Neither choice blocks Gate D or the
reporters. Confidence: high.

## Related artifacts

- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/telemetry/event-stats-store.ts` (lines 14–18, 55)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/web/vishnu/src/lib/graph/event-stats.ts` (line 37)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/declared-topology.ts` (lines 19–133)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/build-and-deploy.md` (§ Decisions required, item 4)
- [d3](d3-mq-scope-model.md), [d5](d5-broker-isolation-and-audit.md)
