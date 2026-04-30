# soa_75 — outbox / event-driven projections POC

Proof-of-concept exploration of refactoring the rostering /
program-hub / student-data-system service mesh away from
synchronous point-to-point tRPC and toward an outbox-publisher
+ consumer-projection pattern. The POC will pick a narrow
slice of the existing surface (likely the programs-api →
iam-api Pod / enrollment mutation surface, and / or one
ads-adm-api read fan-out) and stand it up end-to-end to expose
the real costs and design questions before any broader
commitment.

## Scope

Spans 4 repos, all on `soa_75` branch (the soa branch base is
TBD — see "Sequencing" below):

- `soa` — shared infrastructure, this project directory
- `rostering` — iam-api (candidate outbox publisher)
- `program-hub` — programs-api (publisher and/or consumer of
  upstream iam projections)
- `student-data-system` — ads-adm-api (consumer of iam + pgm
  projections), ledger-api (already publishes events; useful
  reference implementation)

Branch base per repo:

| Repo | Base branch | New branch |
|---|---|---|
| `rostering` | `snapshot-rename` | `soa_75` |
| `program-hub` | `snapshot-rename` | `soa_75` |
| `student-data-system` | `main` | `soa_75` |
| `soa` | TBD | `soa_75` |

## Layout

```
claude/projects/soa_75/
├── CLAUDE.md            # this file
├── sources/             # raw source material — Slack threads, PR comments, prompts
├── research/            # synthesized current-state + option analysis
└── decisions/           # decision docs needing review (PENDING → RESOLVED)
```

Same shape as `student-data-system/claude/projects/federated-fixture/`.

## Decision docs — rule of thumb

Inherits from repo-root CLAUDE.md: any decision needing the
user's review goes here as a markdown doc. Topic-first naming,
`PENDING` at top until resolved (then flip to `RESOLVED <date>`
with one-line summary). Each doc carries Context / Options /
Recommendation / Related artifacts.

## Reference projects

- `student-data-system/claude/projects/federated-fixture/` — the
  active HTTP-only fixture redesign. Its
  `decisions/d4.4-event-driven-projections-impact.md` is the
  evaluation of Seth's six-item proposal that motivated this
  POC; `sources/prompt-2.md` is the original Slack thread.
- `student-data-system/claude/projects/sds_80/` — the parent
  fixture history (phase-0 through phase-5) and the
  `fixture-architecture-three-schools.md` framing.

Per d4.4's recommendation (D1.A), federated-fixture (fixture
work) lands first; soa_75 is the parallel structural
exploration. The two are forward-compatible: d4.3's
`(source, sourceId)` natural-key columns become event message
keys; the HTTP mutation surface becomes the publisher write
path that emits events.

## What this initiative challenges

The synchronous point-to-point tRPC topology captured in
`research/01-current-architecture.md`:

- programs-api `pods.*` and `enrollment.setPeriodAssignments`
  block on iam-api on the user request path, with no
  transactional boundary across hops. Failures partway through
  multi-call sequences leave inconsistent cross-service state.
- ads-adm-api fans out 3–5 saga_api (legacy aggregator) calls
  per attendance read or analytics query, with no projection
  layer.
- No consumer holds a local replica of upstream domain data.

The proposed direction (Seth's six-item program in
`student-data-system/claude/projects/federated-fixture/sources/prompt-2.md`):

1. Outbox publisher extracted from ledger-api → reused by
   iam-api and programs-api.
2. Shared event-consumer scaffolding (`consumed_events`
   idempotency, DLQ, retry budget).
3. `event-envelope` schemas codifying ledger-api's informal
   convention.
4. Contract-verifier CI step in publisher repos.
5. Consumer projections in programs-api (`iam_*_ref` tables)
   and ads-adm-api (`iam_*_ref` + `pgm_*_ref` tables) — the
   architectural change that dissolves cross-service-fixture
   coupling at runtime.
6. Snapshot endpoints per publisher for cold-start backfill /
   drift recovery.

Plus the separate Pod-ownership re-homing question, which
projections alone don't solve — mutating cross-service intents
need either domain re-homing or a saga-style coordination
pattern.

## Conventions

Inherits from soa repo-root CLAUDE.md:

- pnpm only (never npm/yarn)
- ESM only (`"type": "module"`)
- TypeScript strict mode
- Zod for validation, Inversify for DI
- 4-space indentation
- Sector pattern for domain organization
- Tests for every new feature

## Sequencing

Sequenced relative to federated-fixture per d4.4 D1.A: the
fixture work lands first (~9–11 days, HTTP-only fixture
redesign) and unblocks dev-environment fixtures. soa_75 starts
as a read-only POC slice — likely consumer projection in
programs-api backed by a single iam-api event type — to make
the cost / shape concrete before committing to the full
six-item program.

GitHub issue: see soa#75 for active POC tracking and
cross-repo branch state.
