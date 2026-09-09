# 01 — Comprehensive understanding: scheduling topologies (A/B treatment switches) → sessions

> Synthesized from three parallel code deep-dives (scheduling model + Kevin Zhang's
> rotation work · schedule→session realization · existing tests/seed/flow-model),
> 2026-07-02. Every claim is code-grounded; key `file:line` refs inline. This is the
> **oracle** for the new flow — what *correct* behavior is — plus where reality currently
> falls short. Parent: soa#214 · tracker: soa#221 (Flow content → new scenarios).

## Reference legend (how to read the shorthand in this doc)

The body is deliberately terse; every coded reference below is resolvable here.

- **Design-decision codes — `D8`, `D17`** → the resolved-decisions registry
  `program-hub/specs/context/decisions.md` (headed `## D<n> — …`). Used here:
  - **D8** — *"Slot regeneration is a known break-deep-links operation."* Slots are
    **soft-deactivated** (`deactivatedAt`), never hard-deleted, so a re-mint preserves
    started-session identity and deep links.
  - **D17** — *"Timezone is owned at the Schedule level."* Exactly one authoritative,
    non-null IANA tz per `Schedule`; slots/rules carry none and derive it.
    `UpsertSchedule.timezone` is **required** (fail-loud if ever absent, never a server-tz
    fallback); `Program.timezone` is only a creation-time prefill.
- **Issue / PR references:**
  - **soa#214** — parent effort: the OCLIF CLI for synthetic-dev (saga-stack-cli).
  - **soa#221** — the saga-stack-cli work tracker; this flow is its
    *"Flow content → new scenarios"* item.
  - **saga-dash#226** — *"the VARIES modeling gap"*: the live `createVariesByDayType`
    path emits **no recurring `slot.created`** for a day-type schedule's base cadence, so
    `VARIES_BY_DAY_TYPE` schedules don't drive sessions the way weekly ones do. Fully
    unpacked in **§5**.
  - **#175 / #189** (branch `feat/rotation-slots-unified`) — the rotation-slots
    implementation PRs (Kevin Zhang) that introduced the A/B mechanics dissected in **§3**.
- **`P0c`** — the scheduling **per-date-overrides** workstream/phase; it added the
  `SlotOccurrenceCancellation`, `OccurrenceTimeOverride`, and `ManualAddition` models (§2).
- **"stage-N" (e.g. stage-5/6)** — the **saga-dash journey e2e stages**
  (`saga-dash/apps/web/dash/e2e/journey/*.e2e.test.ts`): **stage-5 = schedule**,
  **stage-6 = sessions**. Their tRPC-direct `rpcGet` + `expect.poll` pattern is the
  assertion precedent this flow mirrors (see §6, and `02-flow-design.md` §4).
- **rrule syntax** (`FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=…`, and `rrule=''`) — RFC 5545 iCalendar
  recurrence rules. `rrule=''` = a **blank placeholder** that fires no occurrences.
- **`:NN` after a filename** (e.g. `schema.prisma:101`) — a **line number** in the file
  named at the start of that section.

---

## 0. The one-sentence oracle

An **"A/B switch between treatments"** is a program **period with ≥2 rotations**, where
each rotation is a **slot** (an RRULE-bearing row) that carries **its own
`treatmentKind`** via a `PodAssignment`; the period's **`rotationPattern`** decides *which
rotation's slot fires on each date*, so a pod's **realized session on a given date carries
whichever treatment belongs to the rotation that meets that day** — the treatment
"switches" across dates as an *emergent* property of `(slot rrule) × (slot pod_assignment)`,
with **no per-session switch logic** anywhere.

**Correct behavior to assert:** for a schedule where rotation A (tutored, `CONNECT`) meets
on some dates and rotation B (non-tutored, `NON_TUTORED`) on others, the sessions returned
by `sessions.dayList`/`rangeList` must show, per date, the **right `slotId` + `treatmentKind`
+ count**, matching the rotation whose rule fires that day.

## 1. Glossary (the domain vocabulary)

| Term | Meaning |
|---|---|
| **Schedule** | one per program; owns `patternType` (`SAME_EVERY_WEEK` \| `VARIES_BY_DAY_TYPE`) + the authoritative IANA `timezone` (D17). scheduling-api aggregate. |
| **Period** (`TutoringPeriod`) | a program's recurring block; carries `rotationCount`, `rotationPattern`. programs-api. |
| **Rotation** | one "arm" of a period, `rotationIndex ∈ [1, rotationCount]`; UX labels "Rotation A/B/C". Realized as exactly one **slot**. |
| **Slot** | scheduling-api's "a rotation"; physically a `RecurrenceRule` row with non-null `periodId`, its own `rotationIndex` + times + (own RRULE \| per-date anchors). |
| **treatmentKind** | the pedagogical condition: `CONNECT` (tutored) vs `NON_TUTORED`. ⚠️ **triple-cased**: `CONNECT\|NON_TUTORED` (wire), `TUTORING\|NON_TUTORED` (Prisma), `tutoring\|non_tutored` (event). |
| **PodAssignment** | junction `(pod, slot) → treatmentKind`. "this pod meets in this slot with this treatment." Its `treatmentKind` **strictly wins** over the slot's soft `treatmentDefault`. |
| **rotationPattern** | the RULE selecting which rotation applies: `no_rotation \| varies_by_day_type \| split_period \| custom`. |
| **PodAssignmentOverride** | per-date exception on a standing assignment: `SWAP` (rebind pod) \| `ABSENT` (suppress). Changes *effective pod*, **not** treatment. |
| **Scheduling topology** | the full meeting shape: schedule `patternType` × `rotationPattern` × rotations × time windows × exceptions. An **"A/B topology"** = a ≥2-rotation period whose rotations carry different treatments. |

## 2. The scheduling model (scheduling-api)

`apps/node/scheduling-api/src/prisma/schema.prisma`:
- `Schedule` (`:12`) — `patternType` (`:35`), non-null `timezone` (`:20`, D17), optional term `startDate`/`endDate`, unique on `programId`.
- `PeriodScheduleConfig` (`:42`) — `SAME_EVERY_WEEK`: per-period `activeDays[]` + typical `startTime`/`endTime`.
- `DayType` + `DayTypeBlock` (`:62`,`:76`) — `VARIES_BY_DAY_TYPE`: named day types (e.g. "A Day") with per-period time blocks.
- **`RecurrenceRule`** (`:101`) — the source of truth. `periodId?` (slot-shaped) or `dayTypeId?` (day-type-scoped), `rotationIndex` (default 1), `dtstart`, `rrule` (bare `FREQ=…`), `exdates[]`, per-slot times, `deactivatedAt?` (soft-delete, D8), `oneOff`. **Partial unique index**: one active slot per `(scheduleId, periodId, rotationIndex)` where not deactivated & not oneOff (migrations `20260611100000`/`20260701020000`).
- `CalendarEvent` (`:141`) — materialized dense cache of concrete dates.
- **P0c per-date overrides** (`:177`+) — `SlotOccurrenceCancellation`, `OccurrenceTimeOverride`, `ManualAddition`.
- Local projections incl. `RotationConfigProjection` (`:297`, mirrors the Pod-Builder config, `sourceTs`-guarded).

A **slot** = one `RecurrenceRule` with `periodId` non-null (`slots.service.ts:18`); it holds *either* its own slot-scoped RRULE (weekday rotation) *or* `rrule=''` + per-date anchors (day-type / split / custom). Day-type-scoped rules (`periodId` null) are **not** slots.

## 3. The A/B mechanics — Kevin Zhang's rotation work (`feat/rotation-slots-unified`, #175/#189)

### 3.1 How an A/B switch is modeled
Provider (programs-api): a `TutoringPeriod` has `rotationCount` + `rotationPattern`; per-rotation `RotationConfig` rows carry `days[]` (weekdays), `dayTypes[]` (day-type refs), `timeSlot?` (split), `mergedFrom[]`; `custom` uses `RotationCalendarDay` (`date→rotationIndex`). Saved via `setRotationConfig` (`periods.service.ts:423`, validates every index ∈ `[1,rotationCount]` → else `INVALID_ROTATION`, no event) → emits **`programs.period_rotation_config.changed.v1`** (full-state snapshot, not a delta).

Consumer (scheduling-api): projects the config into `RotationConfigProjection` and **mints one slot per `(period, rotation)`**, each with its own recurrence + (via programs-api) its own `PodAssignment.treatmentKind`.

### 3.2 The four switch rules (`schedules.service.ts:558-598`, `programs-projection.ts:442-508`)
`ROTATION_MANAGED_PATTERNS = [varies_by_day_type, split_period, custom]`:
1. **`varies_by_day_type` (weekday)** — each rotation owns weekdays; each rotation's slot gets a **sub-RRULE restricted to its weekdays** (e.g. A=Mon/Wed `CONNECT`, B=Fri `NON_TUTORED`). Switch = **day-of-week driven**.
2. **`varies_by_day_type` (day-type, on a `VARIES_BY_DAY_TYPE` schedule)** — routing key is the **day-type name**; `resolveRotationIndices` (`rotation-config-match.ts:25`) matches each painted date's day type against rotations' `dayTypes[]` and anchors the date onto the matched rotation slot(s). Switch = **day-type driven**.
3. **`split_period`** — **both rotations meet every meeting date**, each on its **half of the time window** (`splitWindow`, `rotation-slot-time.ts:29`). Switch = **intra-day, time-of-day driven** (First Half → A, Second Half → B).
4. **`custom`** — explicit `date → rotationIndex` map; each painted date anchored onto its rotation's slot (`rrule=''`). Fully admin-controlled cadence, one rotation per date.
5. `no_rotation` — single period-scoped slot, single treatment (pre-rotation behavior).

**mergedFrom / A/B merge day**: a day/day-type may drive *multiple* rotations; `resolveRotationIndices` returns a de-duplicated sorted index array → both arms meet together.

### 3.3 When the switch commits to the timeline
- On `schedules.upsert` (create/edit) → per-rotation slots minted.
- **Reactively** on `period_rotation_config.changed` → `remintPeriodFutureSlots` (`programs-projection.ts:370`) — **future-only, identity-preserving**, atomic deactivate-old + mint-new in the same consume tx (avoids half-applied state), `sourceTs`-guarded (skips stale/equal redelivery so re-mint can't duplicate ids).

### 3.4 Invariants & edge cases (design around these in the flow)
One active slot per `(period,rotation)`; slots **soft-deactivated, never hard-deleted** (preserves started-session identity); one tz per schedule; **PodAssignment.treatmentKind strictly wins** over slot default; the **M-W-F→M-F retraction fix** (deactivate the period-scoped rule too, else every rotation shows all days); idempotency under at-least-once unordered delivery; **split-period-on-day-type-schedule** would mint zero slots → special-cased.

## 4. How sessions realize (sessions-api) — the pivotal architecture fact

**sessions-api does NOT eagerly materialize sessions.** "Projection" here means **event → local read-model** (CQRS), *not* schedule → session. Concrete sessions are a **pure function evaluated per read request**:

```
expandSchedule(scheduleId, [from,to], ScheduleProjections)     → ScheduledOccurrence[]
   per occurrence: composeTutoringSession(occ, defaultPodId, …) → SessionView
```

- **Seam**: sessions-api is a pure event consumer (RabbitMQ); the request path never HTTPs upstream. Events → mirror tables: `schedule_projection`, `slot_projection` (`rotation_index`,`rrule`), `recurrence_rule_ref`, the 5 override/holiday `*_ref` tables, `period/pod/pod_assignment(_override)_projection`, membership/authz. Idempotent (`consumed_events` dedup, `source_ts` guard).
- **Trigger = a READ** (tRPC `dayList`/`rangeList`/`itemGet`, or S2S `resolveOccurrencesForAttendance`), not a cron. No fixed horizon — bounded by the request window (`rangeList` cap 31d; 5000 composed/req; 1000 rrule occ/window).
- **Unit** = one `(date, periodId, slotId, podId)` tuple the schedule hits. A date the schedule doesn't hit *and* with no instance-fact → **no session** (bulk existence gate).
- **`projection_readiness`** = a fail-closed warmth gate: reads throw `SERVICE_UNAVAILABLE` while warming, never a masked empty. **The flow must wait for warmth** (or seed the readiness rows), else a green-looking 0-session read.

### 4.1 Where the A/B treatment resolves into a per-session value
Purely date-driven, falls out of expansion (`session-composition/src/compose.ts:240-242`):
```
treatmentKind = (slotId ? podAssignment(slotId, asOf)?.treatmentKind : undefined) ?? 'NON_TUTORED'
```
`expandSchedule` runs each `(period, slot)` independently; a slot-scoped rule wins over the period-scoped one, so **the date selects which rotation's slot fires**, and `composeTutoringSession` reads that slot's `pod_assignment.treatmentKind` **verbatim**. Every `SessionView.treatmentKind` (`sessions.ts:146`) / `AttendanceOccurrence.treatmentKind` (`:391`) is thus per-date-correct with **zero switch logic**.

### 4.2 Identity, idempotency, edit semantics
- **Identity** = deterministic `encode(date, periodId, slotId, podId)` (`session-id.ts`); DB `tutoring_session @@unique([date,periodId,slotId,podId])`. Same tuple → same id → idempotent by construction.
- **Schedule edits** reflect on the **next read** (nothing to re-run). Already-**started** sessions preserved (the sparse `tutoring_session` fact row is rrule-independent). **`StrandDetector`** disowns facts orphaned by an rrule edit (sets `disowned_at`, emits `sess.session.stranded_by_schedule`; `SessionView.stranded`).
- **"Must not mint rival slots that duplicate sessions" (saga-dash#226)** — the invariant is **one slot per `(period,rotation)`, shared by all pods**; two slots with the same rrule firing the same day → duplicate cards. Guarded by the demo-projection/render integration tests.

## 5. ⚠️ THE GAP — the single most important strategic finding

The multi-rotation, **slot-scoped, differing-treatment A/B case is fully expressible in the contracts and supported by the read engine — but is NOT seeded or tested end-to-end anywhere today.**

- **sessions-api seed** (`sessions-api/src/prisma/seed.ts:199`) *explicitly* models **single-rotation only**: "a future rotationCount>1 period would need per-rotation slot-scoped rules (slotId non-null)… which is out of scope (the VARIES modeling gap)." Demo South's "A/B" is a single-rotation day-type *decoration* projected as one WEEKLY slot (a documented **fidelity gap** vs scheduling-api's biweekly model).
- **scheduling-api** `createVariesByDayType` emits **no recurring `slot.created`** for the live UI path (saga-dash#226) — so day-type schedules don't drive sessions like weekly ones do.
- **No test — unit or e2e — proves an A/B schedule realizes differentiated sessions.** scheduling-api unit tests (`schedules.service.test.ts` etc.) cover the four mechanisms only at the **event-emission** layer with mock Prisma; sessions-api projection tests use **single-rotation** fixtures.

**Implication for the flow:** this scenario is *net-new coverage*. It will either (a) prove the multi-rotation A/B path works when driven through real seeds/APIs, or (b) **surface exactly where it breaks** — making the flow the artifact that drives closing saga-dash#226 / the VARIES modeling gap. Either way it is high-value. **This is the key design decision to bring to skelly** (see §8).

## 6. Assertion surfaces (what the flow can check)

The **realized-session set lives only behind the read API / compose function — not a DB table**. So: assert *topology* in the DB, assert *realized sessions* via the API.

**Read API → `SessionView`** (`program-hub-types/src/sessions.ts:131-206`), via `sessions.dayList`/`rangeList`/`itemGet` (tRPC-direct, the stage-5/6 `rpcGet` pattern):
- **existence/count per date** (which dates yield a session; how many per pod) — schedule correctness;
- **`treatmentKind`** (`CONNECT`\|`NON_TUTORED`) — **the A/B assertion**;
- `slotId` + `rotation_index` (which rotation fired), `origin` (`rule`\|`manual_addition`), `date`, `defaultPodId`/`effectivePodId`/`overrideApplied` (SWAP/ABSENT), `status`, `cancellation.source`, times/tz/duration.
- S2S `AttendanceOccurrence` (what ADS/ADM consumes): `date, periodId, slotId, podId, treatmentKind, modality, when, users[]{role}`.

**DB projection tables** (assert topology directly, the direct-projection-seed test pattern):
- `slot_projection` — `period_id`, `rotation_index`, `rrule` → **one slot per (period,rotation)** = the A/B topology;
- `pod_assignment_projection` — `slot_id`, `pod_id`, `treatment_kind` → **per-slot treatment**;
- `recurrence_rule_ref` — the rrule placing occurrences; `schedule_projection` (exactly 1/program, tz); `tutoring_session` (sparse, only mutated); `projection_readiness`.

Canonical read assertion (`demo-render.integration.test.ts`): call `dayList` for a date → assert a specific `(date, pod, status, treatmentKind, slotId)` renders, and **no pod renders >1 card on a meeting day**.

## 7. What the flow will look like (from the flow-model deep-dive)

Backend-focused, single-stage, self-seeding `flows.json` entry (schema `saga-stack-cli/src/core/flow/types.ts`). Precedent: `connect-smoke` (narrow backend closure), `connect-session` (`prerequisite` pattern).
```jsonc
{ "name": "scheduling-topology",
  "description": "An A/B rotation schedule realizes the right sessions (slot+treatment) per date.",
  "lanes": ["stack"], "progressive": false,
  "seed": { "reset": true, "profile": "roster", "only": ["scheduling-api", "sessions-api"] },
  "stages": [{ "id": "topology", "phase": 1, "project": "scheduling-topology",
    "spec": "scheduling/topology-ab.e2e.test.ts",
    "requiredSystems": ["scheduling-api", "sessions-api", "programs-api"] }] }
```
(`programs-api` rides along regardless: sessions-api projects from it over `event` edges, and the `slot.created`→`pod_assignment` auto-join lives there. Frontend + `sis-api`/`ads-adm-api` drop out.) The spec builds/seeds the A/B schedule, waits for `projection_readiness`, then asserts via `sessions.dayList` on chosen occurrence dates. Note: **backend-only, no dash UI** — so it is exactly the N-of-M sub-stack the CLI makes cheap, and a clean second-flow proof.

## 8. Open decisions for the flow design (§02)
1. **Target the gap or a working case?** Given §5, do we (a) author the flow to assert the *intended* A/B behavior (expected to fail until saga-dash#226 / the VARIES gap is closed — a spec-first / red-until-fixed test), (b) scope to a topology that *does* realize today (single-rotation weekly, i.e. the journey — low new value), or (c) drive the multi-rotation slot-scoped case via a **purpose-built seed** (slot-scoped rules, `slotId` non-null, differing treatment) and see how far it gets? Recommendation: **(c)** — build the real A/B seed and let the flow reveal reality.
2. **Which rotation pattern(s)?** `varies_by_day_type` (weekday) is the simplest to seed + assert (Mon/Wed=A/CONNECT, Fri=B/NON_TUTORED). `split_period` (intra-day) and `custom` (date-map) are richer follow-ons.
3. **Build the schedule via the API (setRotationConfig + schedules.upsert) or seed the projections directly?** API-built exercises the real emission→projection path (higher fidelity, hits the gap); direct-projection seed isolates the read engine.
4. **Assertion depth:** count+treatment+slot per date (minimum) vs also SWAP/ABSENT overrides, holidays/cancellations, and a schedule-edit re-projection check.

## 9. Footguns to design around
- **treatmentKind triple-enum** — assert on the **wire** value (`CONNECT`/`NON_TUTORED`) from the API; the DB stores `TUTORING`.
- **Day-type join is name-fragile** (`schedulingDayTypeId` inert today → name-matching only) — seed names consistently.
- **PodAssignmentOverride (SWAP/ABSENT)** specs still in `drafts/` — verify build state before asserting.
- **`projection_readiness`** — wait for warmth or reads mask to 0.
- **Term dates are mandatory** — without both, the slot stays a blank `rrule=''` placeholder that drives nothing (stage-5 lesson).

## References
scheduling-api: `src/prisma/schema.prisma`, `services/schedules.service.ts`, `services/slots.service.ts`, `event-handlers/programs-projection.ts`, `rotation-config-match.ts`, `services/rotation-slot-time.ts`, `src/__tests__/unit/schedules.service.test.ts` · programs-api: `src/services/periods.service.ts` · sessions-api: `src/sectors/sessions/{sessions-read.service.ts,composition-projections.ts,session-id.ts}`, `src/event-handlers/*-projection.ts`, `src/prisma/{schema.prisma,seed.ts}`, `demo-projection.integration.test.ts`, `demo-render.integration.test.ts` · libs: `packages/node/{schedule-expansion,session-composition,programs-events,program-hub-types}` · saga-dash e2e: `apps/web/dash/e2e/journey/{schedule,sessions}.e2e.test.ts` · flow model: `soa/packages/node/saga-stack-cli/src/core/flow/types.ts`, `examples/flows/*.flows.json`.
