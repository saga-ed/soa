# 02 — Fleet-wide cross-service mutation audit + handoff

Handoff from work done in the `claude-plugins` worktree
(`graceful-frolicking-sprout`) on 2026-04-30. The full source
artifact is the target-architecture plan at:

```
~/.claude/plans/graceful-frolicking-sprout.md
```

That plan describes the destination architecture (per-service
DBs, events at write boundaries, consumer-owned projections,
contracts at seams, layered tests) and includes a greenfield
A/B/C reference, a tooling pressure-test, and a worked
description of how test scenarios get set up under the modern
shape (~95% don't replay events — they seed projection tables
directly via Drizzle/Prisma).

This document captures the fleet-wide audit findings, which
are the most directly actionable handoff into soa_75's POC
scoping.

## Why this audit

soa_75's POC was scoped against the programs-api → iam-api Pod
seam (~21 mutating call sites across `pods.service.ts` and
`enrollment.service.ts`, four methods on `RosteringClient`).
Before committing to that as *the* representative seam, the
question was: are there other cross-service mutating seams in
the saga-ed fleet that would change the architectural picture
or the POC's representativeness?

Five parallel read-only audits covered: student-data-system,
rostering, rtsm + qboard, ms_temp/services + cu-saga-shared,
coach + program-hub + nimbee/edu/js/app/saga_api.

## Findings — three categories

### Clean (zero cross-service mutating calls)

- **rostering/iam-api** — zero outbound calls of any kind.
  Correctly isolated as identity source-of-truth.
- **sds/ads-adm-api**, **sds/ledger-api** — only
  `SagaApiClient.query()` reads against the legacy saga_api
  federation gateway. All mutations stay local (Prisma).
  `attendance.int.test.ts`'s "no saga_api required" pattern
  reflects this.
- **rtsm** — domain-isolated; vends a public read endpoint
  to connectv3 only.
- **program-hub/programs-api, pods-api, scheduling-api** —
  three isolated REST APIs, no backend-to-backend calls
  between them; the Pod/Group seam against iam-api is the
  already-known case.
- **coach-api** — read-only saga_api calls
  (`getUserPolicy`, `validateAuthCookie`).

### Real cross-service mutating seams

In rough priority order:

1. **programs-api → iam-api** (the known case) — ~21
   Pod/enrollment mutating sites. Ownership-seam
   misplacement. Two viable resolutions:
   - **Option A** — Pods own membership locally;
     iam-api drops Pod-shaped Groups (cleaner ontology;
     read-aggregator cost).
   - **Option D** — Flip the seam direction: iam-api
     consumes programs-api events. Source plan
     characterizes this as **lower blast radius** since
     it's a single consumer-projection refactor with no
     downstream read-aggregator work; iam-api becomes
     both publisher and consumer.

2. **qboard/connectv3-api → saga_api** —
   `updateLearnSessionStatus(slsId, ATTENDED|IN_PROGRESS)`
   GraphQL mutation at
   `apps/node/connectv3-api/src/saga-api/client.ts:157`,
   called from `routes/session.ts:148`
   (POST /session/:slsid/mark-attended). Race-prone: no
   idempotency on saga side, only local CAS in connectv3.
   Modern shape: connectv3 publishes `session.attended`
   event; consumed where session lifecycle lands
   post-saga_api retirement.

3. **ms_temp ingester services → saga_api** —
   `roster_ingester` (`sync_roster_from_s3`) and
   `clever_nightly_sync` (`sync_clever_orgs`) push external
   roster data into the legacy monolith via GraphQL
   mutations. Modern shape: re-target to iam-api with
   contract test, or publish ingest events.

4. **ms_temp LLM postprocessing → saga_api** —
   `response_postprocessing` (`create_fa_insight_note` per
   observation in a loop) and `tutor_tips`
   (`upsert_hqt_personalized_tips`). AI-derived insights
   land in legacy monolith; should land in
   insights-owning service or as published events.

5. **qboard/connectv3-api → fleek-recorder, LiveKit** —
   `pushPlan/pushEnd` to recorder,
   `RoomServiceClient.deleteRoom`. External-system
   integrations (not Saga fleet); stay synchronous +
   contracted in the modern shape. Fire-and-forget with no
   compensation is the smell, not the seam itself.

6. **cu-saga-shared/notify_partner → external CU service**
   — `POST $ANALYSIS_URL`. Cross-organizational boundary;
   stays sync + contracted.

### Latent — saga_api retirement risk

Legacy saga_api owns ~30+ mutating GraphQL methods
(iam_helper user/policy/membership lifecycle;
participation_helper pod/enrollment; adm_resolvers
attendance). It does **not currently call the modern
services** — all mutations stay inside saga_db (Mongo).
Today: benign isolation. Under modernization: a **race
condition** the moment a modern service starts owning the
same entity.

Implication for sequencing: a modern service going
write-live requires a **paired saga_api write-path
retirement** in the same window. Read-paths can coexist
longer because saga_api can read from a projection of the
modern service's events.

## Aggregate picture

| Seam | Type | Modern resolution |
|---|---|---|
| programs-api → iam-api (Pods) | Internal mutating | Option A or D — *open decision* |
| connectv3-api → saga_api (mark-attended) | Internal mutating | Event from connectv3; consumed where session lifecycle lands post-saga_api retirement |
| roster_ingester / clever_nightly_sync → saga_api | Internal mutating | Re-target to iam-api with contract test, or publish ingest events |
| LLM postprocessors → saga_api | Internal mutating | Re-target to insights-owning service (TBD) or publish events |
| connectv3 → recorder / LiveKit | External-system mutating | Stays sync + contracted; add compensation/retry |
| notify_partner → external CU | External-org mutating | Stays sync + contracted |
| saga_api own mutations vs modern services | Latent (write-races on cutover) | Paired retirement of saga_api write paths during each modern-service write-live window |

## Implications for soa_75 POC scoping

1. **The Pod seam is the only real internal-fleet ownership
   smell.** Every other modern-fleet pair is clean
   (read-only or domain-isolated). This validates picking
   the Pod seam as the POC's structural slice — it isn't
   one of many candidates, it's *the* candidate.

2. **All other "cross-service mutations" are into legacy
   saga_api**, not between modern services. They're
   legacy-bus coupling that disappears with saga_api
   write-path retirement; they don't require the same
   architectural decision as the Pod seam.

3. **For the read-projection POC slice** (per CLAUDE.md
   sequencing — "consumer projection in programs-api
   backed by a single iam-api event type"), the audit
   doesn't change scope but does provide reference
   implementations: ledger-api's outbox-publisher
   (~250 LOC at `sds/ledger-api/src/queue/outbox-publisher.ts`)
   and ads-adm-api's `attendance.int.test.ts`
   ("no saga_api required" pattern).

4. **Open decision for the POC:** if the POC eventually
   demonstrates a *mutating* slice (not just read
   projection), Option A vs Option D for the Pod seam
   becomes a forcing function. Source plan leans toward
   Option D (lower blast radius); Saga's domain ontology
   call (is iam-api the universal membership registry, or
   the organizational identity hierarchy?) decides.

## Open threads from the source plan

These are decision points carried over from the
target-architecture plan, not yet acted on:

- **Pod seam: Option A vs D** (above).
- **Migration sequencing** — which service goes write-live
  first; paired saga_api retirement window per service.
- **Contract harness choice** — Pact + broker vs ts-rest
  verifier scripts in `*-api-types` packages.
- **Gap-fills** — feature flags (OpenFeature + GrowthBook?),
  explicit OpenTelemetry adoption, drift-detection CI job.

## Source plan contents (for cross-reference)

The full plan at
`~/.claude/plans/graceful-frolicking-sprout.md` includes:

- Context, three-fabric model (event/projection/contract)
- Per-service shape (iam-api / programs-api / ads-adm-api
  detailed test strategies)
- Cross-cutting infrastructure table
  (`@saga-ed/event-envelope`, `soa-outbox-publisher`,
  `soa-event-consumer`, etc.)
- "What dies" / developer experience walkthroughs
- Greenfield A/B/C reference + tooling pressure-test
  (settled / close-call / over-engineered classification)
- "How a test scenario actually gets set up" (Layer 1/2/3
  with code examples — the muscle-memory shift point:
  events propagate projections in production; tests seed
  projection tables directly)
- Reading list (Fowler, microservices.io, Debezium,
  Shopify CDC, Pact, Capital One, Signadot, Uber SLATE,
  Lyft, etc.)

If pulling from the source plan into soa_75's
`research/` or `decisions/`, prefer extracting the
sections relevant to the specific decision — the source
plan is wide-scope and includes material that's
deliberately out-of-scope for soa_75's POC slice.
