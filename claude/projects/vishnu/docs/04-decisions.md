# 04 — Decisions (index)

All resolved. The full documents, with options and rationale, are in
[`../../gh_536/decisions/`](../../gh_536/decisions/).

| # | Topic | Ruling (one line) |
|---|---|---|
| [d1](../../gh_536/decisions/d1-event-stats-routing.md) | Routing | Reports go on each service's own exchange, key `observability.event_stats.reported`; Vishnu owns only its queues; no per-service broker users. |
| [d2](../../gh_536/decisions/d2-project-location.md) | Project location | Keep the personal `claude/projects/gh_<n>` convention. |
| [d3](../../gh_536/decisions/d3-mq-scope-model.md) | Scope | Datadog environment-wide; MQ exact scope `{env, deployment, broker, vhost}`; dev deployment `main`. |
| [d4](../../gh_536/decisions/d4-receiver-store-and-colour-ownership.md) | Store | Vishnu's own db-host-v2 Postgres; colours share store and queue. |
| [d5](../../gh_536/decisions/d5-broker-isolation-and-audit.md) | Broker | Shared dev broker user; live binding audit (clean) re-run before enabling. |
| [d6](../../gh_536/decisions/d6-topology-mapping.md) | Mapping | Literal reporter allowlist; stats only on the reporting node; `qboard_connectv3` → `connectv3` alias. |
| [d7](../../gh_536/decisions/d7-activation-and-rollback.md) | Activation | `EventStatsEnabled` deploy param; IAM → Programs → Scheduling, 60 min each, 48h soak; reporting off first on rollback. |
| [d8](../../gh_536/decisions/d8-event-stats-zod3-crash.md) | Zod 3 crash | event-stats 0.1.1 compatible with Zod 3 and 4; CI under Zod 3; boot smoke check in adopter CI. |
| [d9](../../gh_536/decisions/d9-vishnu-sandbox-observation.md) | Sandbox observation | The idle colour (blue) observes one named sandbox, off by default. |
| [d10](../../gh_536/decisions/d10-full-fleet-instrumentation.md) | Fleet scope | Two waves. Wave 1: sessions, content, chat, insights, transcripts. Wave 2 (coach, authz-api, authz-sync) waits on where consumer-only services report. |

**Open design question for wave 2:** where do consumer-only services report? (i) another
team's exchange, (ii) a new shared `observability.events` exchange, or (iii) not yet. See d10.
