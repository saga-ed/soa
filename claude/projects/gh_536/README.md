# RabbitMQ event telemetry

Provide service-originated producer/consumer statistics to Vishnu through the shared SOA event libraries. The shared contract distinguishes transport acceptance, actual committed work, duplicates, failures, and unavailable measurements.

## Work boundaries

- [I#535](https://github.com/saga-ed/soa/issues/535): shared package and instrumentation.
- [I#537](https://github.com/saga-ed/soa/issues/537): service adoption and synthetic-dev proof.
- [I#538](https://github.com/saga-ed/soa/issues/538): Vishnu ingestion, aggregation and UI.

## Branches and runtime

Epic branch: `gh_536-event-telemetry` at `/home/skelly/dev/soa/.claude/worktrees/gh_536-event-telemetry`.
Child branch: `gh_535-event-stats` at `/home/skelly/dev/worktrees/soa-gh_535-event-stats`; PR target is the epic branch.
Set `gh536` binds slot 3 to the child checkout. Use `SS_ACTOR=gh536` on mutating ss commands and `--set gh536` for stack operations. Do not use slot 0 for this initiative. No services have been started for this set.

## Decisions and evidence

- [Routing decision](decisions/d1-event-stats-routing.md): reuse existing publisher exchanges and telemetry-specific routing, with a wildcard-binding audit before enabling reports.
- [Project location](decisions/d2-project-location.md): personal `claude/projects/` convention retained.
- [Preparation record](research/01-worktree-preparation.md): baseline, recovery snapshot and slot restoration details.
- `sources/`: verbatim requests and issue snapshots; consult live issues for current state.

## Existing Vishnu implementation

The original application and ss integration remain in `/home/skelly/dev/soa` on `work/vishnu-discovery-handoff`. They include uncommitted work and are not automatically part of this epic. Preserve and deliberately port the Vishnu changes for I#538; do not copy the old lockfile or unrelated CLI edits over current main.

## Infrastructure test entry point

[Prepared synthetic slot, repeatable scenario and release gates](docs/synthetic-event-stats.md).
Following infrastructure validation, the user authorized the statistics UX on
2026-10-23: API inspectors, MQ badge previews, expanded declared topology, and
Datadog-backed service observations with external flow-analysis links. See
[the I#538 scope](../gh_538/README.md).
