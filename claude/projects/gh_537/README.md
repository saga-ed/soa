# I#537 — Service adoption

Part of I#536. Synthetic test set `gh536`, slot 3.

First slice: iam-api, programs-api, scheduling-api. Test pre-release packages using isolated workspace links.

Implemented all relay/consumer wiring in the three isolated adopter worktrees;
see [the test/release runbook](../gh_536/docs/synthetic-event-stats.md) for pins,
local overlays, coverage and the package-publication/lockfile gate.

[Observed participant and broker-binding inventory](research/participant-inventory.md).
