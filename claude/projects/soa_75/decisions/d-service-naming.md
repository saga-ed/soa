# d-service-naming — Abstract names (identity-svc / catalog-svc / admissions-svc)

RESOLVED 2026-04-30: Abstract service names — `identity-svc`, `catalog-svc`, `admissions-svc` (and `analytics-svc` in Phase 3) — rather than mirroring the real services (`iam-api` / `programs-api` / `ads-adm-api`).

## Context

The POC mirrors a real production triplet (rostering's iam-api, program-hub's programs-api, student-data-system's ads-adm-api). Naming choice affects how directly POC code can be lifted into the real services and how the artifact reads to outsiders.

## Options considered

1. **Abstract names** *(chosen)* — `identity-svc`, `catalog-svc`, `admissions-svc`. POC reads as a standalone teaching artifact; pattern is generalizable beyond the specific domain.

2. **Real-service-mirrored** — `iam-api`, `programs-api`, `ads-adm-api`. Code can be lifted verbatim into the real services with grep-and-replace. Trade-off: implies the POC IS a draft of the real services, which it isn't — it's a model.

3. **Hybrid** — `iam-svc-poc` / `programs-svc-poc` / `admissions-svc-poc`. Explicit `-poc` suffix signals "this is a model." Slightly verbose.

## Recommendation

**Abstract names.** Reasons:

1. **The POC is a teaching artifact**, not a draft of the real services. Abstract names signal "you're meant to learn the patterns, not lift the code."
2. **Patterns generalize.** Lessons (transactional outbox, frozen-forever versioning, hybrid contract testing, eventual-consistency UX) apply to any domain. Abstract names invite that generalization.
3. **Avoids confusion** if someone reads the POC expecting full iam-api fidelity and finds a simpler model.

The downside (slightly more work to "lift" the code into iam-api at back-port time) is small — the back-port is a re-implementation against the new packages anyway, not a copy-paste.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § Decision walkthrough log
