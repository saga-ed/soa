# Shared event statistics

Implement the shared event-stats contract, lifecycle instrumentation, bounded accumulator and best-effort reporter described by [I#535](https://github.com/saga-ed/soa/issues/535). Service adoption and Vishnu UI are separate child issues of [the epic](../gh_536/README.md).

## Working context

Branch: `gh_535-event-stats`; PR target: `gh_536-event-telemetry`.
Checkout: `/home/skelly/dev/worktrees/soa-gh_535-event-stats`.
Runtime: `--set gh536`, slot 3; use `SS_ACTOR=gh536` for mutating ss commands.

## Constraints

Follow the epic's [routing ruling](../gh_536/decisions/d1-event-stats-routing.md) and [preparation record](../gh_536/research/01-worktree-preparation.md). Reinspect current-main hook semantics and activity gates before implementation. Unsupported publish confirmations remain unavailable; duplicate skips must not count as newly committed work. Reporter failures cannot change business outcomes.

Use root `CLAUDE.md`, `.claude/rules/event-driven.md`, `.claude/rules/testing-node.md`, and `docs/testing/`. The original Vishnu application remains in the primary discovery checkout and is not present on this branch.

`sources/` holds verbatim request/issue snapshots. `research/` is reserved for measured implementation findings. GitHub owns delivery status.

Implementation evidence: [boundary decisions and validation](research/01-implementation-validation.md).
Package contract and adoption guide: [event-stats](../../../packages/node/event-stats/README.md).
