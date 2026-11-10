# d4 — Receiver store and blue/green ingestion ownership (dev)

RESOLVED — 2026-10-28

User ruling: "As recommended". A1: Vishnu's own container database on db-host-v2
(URL in Secrets Manager `soa/vishnu/dev/database-url`). B1: one shared store, and
whichever colours are running consume the one durable queue; future schema changes
stay compatible across one version (expand, then contract).

## Context

Hosted Vishnu needs a durable store before MQ can be enabled (`VISHNU_DATABASE_URL`
is required when MQ is on, and none exists in dev). The handoff also asks who ingests
across blue and green, so that neither colour's read API shows a partial view.

What the code already does (`apps/node/vishnu-api/src/telemetry/`):

- The store owns its schema: `CREATE TABLE IF NOT EXISTS event_stats_source` at boot
  (`event-stats-store.ts:43`), with no migration tool.
- It is small and self-bounding: one upserted row per source, at most 256 sources,
  64 retired epochs per source, and 24h retention pruned on every write.
- It already expects several receivers on one database. Each write takes a row lock
  (`FOR UPDATE`) and serialises capacity and epoch checks "across receiver replicas"
  (`event-stats-store.ts:60`). A report is acked only after its database commit.
- The queue `vishnu.main.event-stats.v1` (deployment value from d3) is durable and
  bounded (`x-max-length` 10,000, `x-message-ttl` 1h). Rejected reports dead-letter to
  `.invalid` (100 messages, 1h). It binds only the telemetry routing key and never
  creates publisher exchanges (`checkExchange`), consistent with d1.

Dev green normally runs zero tasks. Both colours run only briefly during a cutover.

## Decision A — where the store lives

1. **Vishnu's own container database on db-host-v2.** Provisioned through the dev
   orchestrator like every other dev service, on its own EBS volume, with the URL
   held in Secrets Manager (`soa/vishnu/dev/database-url`) and task-SG → db-host-SG
   ingress on its engine port.
   - Follows the dev convention (one database per service). Cheap, and recovered
     automatically when an instance is replaced.
2. **A dedicated small RDS instance.**
   - More durable than needed for 24h of telemetry, and adds cost and a new stack.
3. **A schema inside another service's database.**
   - Breaks one-database-per-service and couples Vishnu to another team's database.

## Decision B — which colour ingests

1. **One shared store; whichever colours are running consume the one queue.** Both
   colours point at the same database and compete for the same durable queue. The
   store's row locking keeps writes consistent, so either colour's read API shows the
   complete view.
   - No new code. It relies on concurrency handling the store already has.
   - During a cutover, old and new versions write the same table, so any future
     schema change must stay compatible across one version (expand, then contract).
2. **Only the live colour consumes**, gated on the active-colour SSM parameter (the
   `soa-deploy-color` `resolveGate` pattern iam-api's lake export uses).
   - Never more than one writer version. Needs gate code, and a stale parameter could
     leave no consumer (reports expire after 1h, so this is bounded).
3. **A separate store and queue per colour.**
   - Each colour sees only the reports it happened to receive, which is the
     partial-view problem the handoff warns against.

## Recommendation

**A1 and B1.** A1 is the standard dev pattern and fits a small, self-pruning store.
B1 needs no new code because the store was built for concurrent receivers, and it
gives both colours a complete view. Its one cost, cross-version schema
compatibility, is the normal blue/green rule anyway. The schema stays
application-owned (`CREATE TABLE IF NOT EXISTS`) until it first needs to change; that
change adopts expand/contract. Revisit B2 for prod if mixed-version writers become a
concern. Confidence: high for A1, medium-high for B1.

## Related artifacts

- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/build-and-deploy.md` (§ Decisions required, item 2)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/telemetry/event-stats-store.ts` (lines 35–100)
- `/home/skelly/dev/worktrees/soa-gh_536-event-telemetry/apps/node/vishnu-api/src/telemetry/event-stats-receiver.ts` (lines 80–97)
- `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0/references/db-host-v2.md`
- [d1](d1-event-stats-routing.md) (routing), [d3](d3-mq-scope-model.md) (scope; deployment value `main`)
