# I#538 — Vishnu ingestion

Part of I#536. Synthetic test set `gh536`, slot 3.

Implement server-side receiver, persistence and read API for synthetic dev. Statistics UX is deferred until infrastructure testing is complete.

The receiver, dedicated PostgreSQL store, scope/epoch checks and local
`/api/event-stats` endpoint are implemented. Existing Vishnu source/logo work was
preserved from the original checkout. No statistics presentation was added.
See [the live test runbook](../gh_536/docs/synthetic-event-stats.md).
