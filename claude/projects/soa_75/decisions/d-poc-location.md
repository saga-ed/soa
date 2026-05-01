# d-poc-location — POC code in soa_event_driven_example; decisions in soa_75

RESOLVED 2026-04-30: POC code lives in a brand-new single-repo at `~/dev/soa_event_driven_example`. Decision docs and findings live here in `soa_75/decisions/` per soa_75 conventions. Patterns back-port to `soa/packages/` only after the POC has soaked.

## Context

The user wanted a green-field POC for event-driven microservices but has an existing in-motion initiative (soa_75) that is a cross-repo refactor of rostering / program-hub / student-data-system / soa. Two natural locations:

- (a) Continue soa_75 across the four real repos.
- (b) Start a brand-new single repo, prove the patterns, then back-port.

## Recommendation

**Option (b) — new single repo.** Reasons:

1. **No cross-repo coordination cost.** soa_75 spans 4 repos all on `soa_75` branches; merging anything requires coordinated branch management. A single repo lets us iterate without that friction.
2. **Free from existing constraints.** The real services have legacy patterns (`@saga-ed/soa-api-core` controller-loader, etc.) that we're explicitly choosing not to inherit. A green-field repo lets us cleanly demonstrate the new shape.
3. **Lessons port back.** Once patterns earn their keep, they generalize into `soa/packages/event-{envelope,outbox,consumer}` and the real services adopt them.

## Layout

- **POC code:** `/home/spaul/dev/soa_event_driven_example/.claude/worktrees/fancy-finding-dream/`
- **Decision docs + findings:** `/home/spaul/dev/soa/.claude/worktrees/stateful-wibbling-babbage/claude/projects/soa_75/decisions/`
- **Eventual back-port:** `soa/packages/node/event-{envelope,outbox,consumer}/` (deferred per `d-poc-scope.md` Option B)

## How this relates to soa_75

soa_75 (the cross-repo refactor branch) and `soa_event_driven_example` (the green-field POC repo) are **complementary**:

- soa_75 captures the **diagnosis** of the real services' coupling problems (`research/01-current-architecture.md`) and the **destination** patterns (`research/03-event-driven-microservices-reference.md`).
- soa_event_driven_example **proves** those patterns are sound by building them end-to-end.
- Once proved, the patterns flow back into soa_75's planned PRs against the real services.

So this decision doc lives in soa_75 because the POC is in service of soa_75's eventual goals.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md`
- soa_75 conventions: `/home/spaul/dev/soa/.claude/worktrees/stateful-wibbling-babbage/claude/projects/soa_75/CLAUDE.md`
