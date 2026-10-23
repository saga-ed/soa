# I#538 — Vishnu telemetry and observation UX

Part of I#536. Synthetic test set `gh536`, slot 3.

The receiver, dedicated PostgreSQL store, scope/epoch checks and local
`/api/event-stats` endpoint are implemented. Existing Vishnu source/logo work was
preserved from the original checkout. After infrastructure validation, the user
expanded scope to statistics presentation on 2026-10-23.

MQ statistics now appear in API inspectors and keyboard-accessible badge previews.
Declared product topology includes saga-dash, Connectv3 and Coach and their API
dependencies, even when those services are not started. Inactive services remain
neutral instead of being labeled unhealthy.

The user chose Datadog as the source for HTTP performance observations and flow
analysis. Vishnu provides an optional cached server-side Datadog adapter, scoped
service metrics, emphasis views and links into Datadog. It does not implement a
trace storage/analysis system. Synthetic slot identity is never silently combined
with cloud dev/prod observations. Runtime credentials remain separate from the
agent's authenticated Datadog MCP connection.

See [the live test runbook](../gh_536/docs/synthetic-event-stats.md) and
[the app configuration and limitations](../../../apps/web/vishnu/README.md).
