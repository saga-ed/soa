# d-event-package-shape — Per-family event packages with shared envelope

RESOLVED 2026-04-30: Four packages — `@example/envelope` + per-publisher `@example/{identity,catalog,admissions}-events`. Mirrors the back-port target shape; ownership visible in `package.json` deps.

## Context

How should event Zod schemas be organized as npm packages? The choice affects publisher-consumer release coupling, contract-check tool structure, and how lift-and-shift to soa fleet repos works.

## Options considered

1. **Single mono-package `@example/events`** — all schemas in one place; everyone depends on it. Simplest mentally. Couples every consumer to every event change. At back-port, would need to be split across rostering / program-hub / student-data-system anyway because cross-repo coupling is bad.

2. **Per-family packages** *(chosen)* — `@example/envelope` (shared types) + `@example/identity-events` + `@example/catalog-events` + `@example/admissions-events`. Each publisher owns its own family. Consumer's `package.json` declares which families it consumes — visible documentation of the consumption graph. At back-port, each `*-events` becomes a per-repo published package (`rostering/packages/iam-events/`, etc.) — drop-in.

3. **Per-publisher in-app packages** (events live under `apps/<svc>/events/`) — maximally aligned with service ownership. But `apps/` are runtime endpoints, not consumable packages; consumer cross-import is murky and doesn't compose with monorepo conventions.

## Recommendation

**Per-family.** Reasons:

1. **Back-port lift is a drop-in.** Each `*-events` package corresponds 1:1 to a future per-repo package in the real fleet.
2. **Consumption graph is documented in package.json.** "admissions-svc depends on `@example/identity-events` + `@example/catalog-events`" is visible at a glance.
3. **Setup cost is small** — four package.jsons at `workspace:*`, no version pinning, no publishing dance.

## Layout

```
packages/
├── envelope/              # @example/envelope — EventEnvelope Zod schema + meta types
├── identity-events/       # @example/identity-events
├── catalog-events/        # @example/catalog-events
└── admissions-events/     # @example/admissions-events
```

## Tooling implications

- `tools/contract-check/check.ts` walks `packages/*-events/` to discover schemas, writes flat snapshot files at `tools/contract-check/published/<eventType>-v<version>.json`.
- Phase 4 event catalog generator walks the same glob.

## Related artifacts

- POC plan: `/home/spaul/.claude/plans/fancy-finding-dream.md` § D4
- Sibling decision: `d-event-versioning.md` (Model A frozen-forever)
- Sibling decision: `d-contract-testing.md` (snapshot + per-consumer pins)
