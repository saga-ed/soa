# d-bulk-mutation-events — How to publish events from bulk mutations

**Status:** RESOLVED 2026-05-06 (with deliberate deferral) —

- **A is the default** for small-N mutations (single-row + small bulk). Proposed threshold: ~100 events per transaction; adjustable later.
- **For paths that would emit high N, prefer information-reduction at the source (U1–U4)** rather than choosing among B/C/D. Pattern-as-event (U2) and deviation events (U3) cover the realistic scheduling-api cases without a high-N transmission ever happening.
- **The high-N transmission strategy (B vs C vs D) is deliberately deferred** until a real adopter case forces it — i.e., a consumer that actually needs row-level fidelity at scale that *can't* be expressed as a pattern or deviation event. No such consumer exists today (programs-api/v2 reads schedule metadata, not per-row events).

**Resolved cuts for scheduling-api's open paths:**
- `SchedulesService.upsert` → **U2** (already emits `ScheduleUpsertedV1`; no change needed)
- `CalendarEventsService.regenerate` → **U2** (one `ScheduleUpserted` per affected schedule; do not emit per-row)
- `CalendarEventsService.setHolidays` → **U3** (one `HolidayMarkedV1` per holiday date; pair with U2 for the underlying pattern)
- Single-row mutations (`cancelEvent`, `createManualEvent`, etc.) → **A** (per-event, status quo)

**Future trigger to revisit:** if a consumer surfaces that needs to react per-row to bulk-driven changes AND the change cannot be expressed as a pattern update or per-deviation event, then this doc reopens at section "Residual transmission options A–D" and B/C/D get picked then.

**Source PRs / triggers:** [program-hub #60](https://github.com/saga-ed/program-hub/pull/60) — scheduling-api's bulk operations are wired through outbox-publishing infrastructure but `setHolidays` and `regenerate` currently emit nothing (deliberate deferral pending this decision).

**Related:** `d-publisher-migration.md` § 4 (which sketched three options at lower resolution and points at this doc).

## Framing

The earlier draft of this doc framed the question as *"how do we transmit N events per bulk operation?"* and laid out four transmission options (A/B/C/D). That framing skipped a more important question: **is N intrinsic to the operation, or is it an artifact of how we represent state?**

The architectural lever is reducing N at the source — emit pattern changes, deviations from a pattern, or instructions to reproduce — so the per-row burst question never arises for bulk operations that are *fundamentally* pattern-level changes. A/B/C/D become the residual question for the cases where row-level fidelity actually matters.

## Context — scheduling-api today

(Architectural reality, surveyed 2026-05-06 against `program-hub@saga-ed/event-driven-adoption`.)

scheduling-api **already has a recurrence model** — it's not a flat materialized-rows-only system:

| Table | Purpose |
|---|---|
| `Schedule` | one per program, declares `patternType` (`SAME_EVERY_WEEK` / `VARIES_BY_DAY_TYPE`), bounds |
| `PeriodScheduleConfig`, `DayType`, `DayTypeBlock` | the pattern itself (period times, day-type rotations) |
| `RecurrenceRule` | the template — RRULE string, `dtstart`, `exdates` |
| `CalendarEvent` | **materialized rows** — `date`, `periodId`/`dayTypeId`, `origin: AUTO\|MANUAL\|HOLIDAY`, `cancelled` |

**Materialization is eager and total.** `SchedulesService.upsert()` and `CalendarEventsService.regenerate()` both expand all RecurrenceRules across the schedule's date range and `createMany()` the resulting `CalendarEvent` rows. Typical school-year window is ~8 months, ~5 periods/day × ~4 days/week × ~32 weeks ≈ 800–1200 rows per program per upsert; thousands when a school has multiple programs and `regenerate` is called.

**`setHolidays` is not the row-explosion case** in current code — it cancels a small set of AUTO events per date by adding to the EXDATE list and creates one HOLIDAY row per date. Typical N: tens, not thousands.

**`regenerate` is the row-explosion case** — it deletes all AUTO events for the schedule and re-expands every rule. Typical N: thousands per call.

**The big finding: programs-api `/v2` does not consume per-row calendar events.** No event handlers in `apps/node/programs-api/src/event-handlers/` subscribe to `calendar_event.*`. The `/v2` enrollment-tree reads schedule metadata — recurrence rules, day types, period configs — and never relies on per-row CalendarEvent state. There is, today, **no consumer that would notice if scheduling-api skipped per-row event emission**.

**Existing event catalog** (`@saga-ed/scheduling-events`):

- `CalendarEventCreatedV1 { id, programId, periodId?, date }`
- `CalendarEventCancelledV1 { id, cancelledAt }`
- `ScheduleUpsertedV1 { programId, mode, rrule?, updatedAt }` — **already a pattern-level event**

`ScheduleUpserted` is the seed of U2 — it already exists, it already carries the RRULE, and `SchedulesService.upsert()` is the natural place to emit it. The bulk-mutation question is partly *"do we keep relying on `ScheduleUpserted` for bulk paths, or switch to per-row?"* — and the absence of any current per-row consumer makes the answer easy: keep using it.

## Upstream alternatives — reduce N at the source

These reduce the information that needs to be transmitted by changing **what** the publisher emits, not just **how** it batches per-row events. Listed roughly in order of fit-with-current-architecture.

### U2 — Pattern-as-event (already partly in place) · *cheapest*

The publisher emits a single envelope describing the new state of the pattern (RRULE, day-type config, period times). Consumers project the pattern locally and re-derive any materialized state on read.

**In scheduling-api code today:** `ScheduleUpsertedV1` is exactly this — payload carries `mode` + `rrule`. To extend coverage to bulk paths, `regenerate()` would emit one `ScheduleUpserted` (or a peer `ScheduleRegenerated`) per affected schedule rather than per-row events. Implementation cost: low — the wire shape exists, the call site is a single transaction, the consumer-side burden depends on the consumer (programs-api `/v2` already doesn't materialize per-row, so it gains nothing to lose).

**Pros:** O(1) events per bulk op regardless of row count. Aligns with how schedule changes are *thought* about ("the schedule for school X changed"). Reuses existing event vocabulary. No reduction in semantic fidelity *for consumers that already don't materialize rows*.

**Cons:** Loses per-row audit trail (which mattered for whom?). New consumers that *do* need row-level state must re-derive (extra logic) or call back to scheduling-api (reintroduces sync coupling, like Option B). Tied to the publisher's pattern model — if pattern shape changes, the event shape does too (unlike per-row events which are stable per `calendar_event` row).

**When it fits:** consumer is fundamentally a pattern-aware projection (programs-api `/v2` qualifies today). For pure read-models that don't care about individual events.

### U3 — Deviation events (exceptions diffed from pattern) · *medium*

Publisher emits one event per **deviation** from the pattern — a holiday, a manual cancellation, a one-off addition — rather than per affected row. The pattern itself is communicated via U2; deviations are layered on top.

**In scheduling-api code today:** the schema already supports this — `RecurrenceRule.exdates` lists exception dates; `CalendarEvent.origin` distinguishes `AUTO` (pattern-derived) from `MANUAL` (manual additions) and `HOLIDAY` (overrides). New event types would be e.g. `HolidayMarkedV1 { scheduleId, date, reason }` and `ScheduleExceptionAddedV1 { scheduleId, date, kind }` instead of N `CalendarEventCancelledV1` events for what is conceptually one holiday application.

**Pros:** N proportional to *operations* not *rows*. `setHolidays` for a winter break of 5 dates = 5 events instead of 5 × (events-per-week-cancelled). Consumers that care can apply each deviation as a delta against their projected pattern. Permanent semantic value (the holiday log is the holiday log).

**Cons:** Consumer must understand pattern + apply deviations (more logic than just receiving rows). Two event vocabularies to keep coherent (pattern + deviations). Some operations don't map cleanly to deviations (e.g., a `regenerate` after a pattern change isn't really a "deviation" — it's a re-expansion).

**When it fits:** the bulk operation is *itself* a pattern-deviation primitive (apply holidays, apply exceptions). Doesn't fit `regenerate` (better as U2 — a new pattern) but does fit `setHolidays` perfectly.

### U1 — JIT (sliding-window) materialization · *largest refactor*

Don't materialize the full 8-month range. Materialize only a sliding window (e.g., next N weeks). Bulk operations only touch what's already in the window; future-dated impacts are applied lazily as the window slides forward via a periodic job.

**In scheduling-api code today:** would require:
- Stop calling `createMany()` for the full date range on `upsert` — instead, materialize only `[today, today + N weeks]`
- Add a sliding job (cron / cloud scheduler) that nightly extends the materialized window by 1 week and applies any pending pattern changes to the newly-materialized rows
- Add a "lazy expand" path for read queries that ask beyond the materialized window (option: refuse and require a different read API; or option: expand into a temp table for the response)
- Materialization-triggered events become trickle-feed (~1 week's worth nightly) rather than burst (8 months at once)

**Pros:** Bulk ops have small N **always** — `setHolidays` and `regenerate` only touch the materialized window (~1 week of rows = tens, not thousands). Option A handles the residual trivially. Decoupled from pattern shape — consumers still see per-row events, just fewer of them.

**Cons:** Substantial refactor of `SchedulesService` + `CalendarEventsService` + read paths. Read API semantics change for "give me this entire school year's schedule" queries. Window-sliding job becomes a new operational concern. Doesn't help if a consumer asks for a far-future window (lazy expand still does a burst, just at read time).

**When it fits:** medium-term architectural direction. Worth doing for reasons beyond event-emission (memory, DB size, agility around pattern changes). Not worth doing solely to solve the bulk-mutation problem.

### U4 — Instructions-to-reproduce (operation-as-event) · *speculative*

Emit the operation that was applied, not its results. Consumers re-execute the operation against their local state.

**In scheduling-api code today:** `BulkHolidayAppliedV1 { schoolId, holidaySetId, dateList, appliedBy }` — the consumer fetches `holidaySetId` (or has it cached) and applies the same logic to its projection. Conceptually similar to U3 but emphasizing the *operation* rather than the resulting deviations.

**Pros:** Most compact. Consumers carry the same business logic as the publisher and stay in sync by re-running ops. Audit trail is operation-shaped (matches how humans think).

**Cons:** **Couples publisher and consumer to share logic** — biggest deal-breaker. Any time scheduling-api changes how holidays are applied (algorithmic change, edge-case fix), every consumer must update in lockstep or diverge silently. Reintroduces the kind of coupling event-driven architecture is supposed to dissolve. Acceptable only if the operation is *trivial* (e.g., "soft-delete by date") and unlikely to evolve.

**When it fits:** rare. Most "instructions" are better expressed as deviations (U3), letting consumers stay logic-free. Mention it for completeness; don't recommend it.

### Comparison

| | U1 JIT | U2 Pattern | U3 Deviations | U4 Instructions |
|---|---|---|---|---|
| Refactor cost | high | low (already partial) | medium | low |
| Reduces N to | small (window) | 1 per op | ~ops count | 1 per op |
| Consumer logic | unchanged | new (project pattern) | new (pattern + apply deltas) | duplicated from publisher |
| Audit fidelity | per-row | none (pattern-only) | per-deviation | per-operation |
| Pattern-evolution-safe? | yes | tied to pattern shape | tied to pattern shape | brittle |
| Fits `regenerate` | yes | great | poor | poor |
| Fits `setHolidays` | yes (small window) | OK | great | OK (but coupling) |
| Fits future per-row consumer | yes | poor (must re-derive) | OK (apply deltas) | OK (re-execute) |

## Residual transmission options A–D

For mutations where N can't be reduced — typically single-row domain mutations (one user created, one program updated) — the question is genuinely *"how do we transmit N events?"*. The four options:

### A. Per-event envelopes — *default for small N*

Every row mutation writes one outbox envelope. Identical pattern to single-row mutations. Outbox + relay handle bursts up to a few hundred without ceremony.

**Recommendation:** **default for N < threshold (proposed: 100 events per transaction).** Below that, broker burst is negligible (~30s drain at default 100 msg/s relay rate), outbox table growth is trivial, consumer drain is fast. Don't over-engineer.

### B. Bulk-summary event with re-fetch contract

Publisher emits one envelope describing the scope; consumer calls back to publisher's read API to fetch affected rows, pinned to a snapshot version.

**When still useful:** *if* a future consumer needs row-level fidelity AND wants per-bulk-op atomicity AND can tolerate the HTTP fall-back. Today, no such consumer exists for scheduling-api (`programs-api/v2` doesn't materialize rows). Keep this option in the catalog for ledger / admissions analogues that may have row-level read-model consumers.

### C. Don't emit (skip bulk paths) — *current de facto state*

Bulk paths bypass the outbox entirely; only single-row mutations emit. This is what scheduling-api does **today**.

**Recommendation:** **defensible *as long as* no consumer needs the data.** programs-api `/v2` doesn't, so the deferral has been correct. Becomes wrong the moment a consumer needs to react to bulk-driven state changes. Pair with U2 (`ScheduleUpserted` covers schedule-shape changes) to reduce the surface where C-as-default is silently wrong.

### D. Per-event with relay rate-cap

Same as A, but the relay enforces a per-publisher rate cap so burst is bounded.

**When useful:** if A is the right semantic model (audit-log consumer, billing consumer, etc.) and broker capacity is the only blocker. For scheduling-api specifically, no such consumer exists today; D is reserved as a backstop for adopters that would have one (ledger fan-out is the likeliest fit fleet-wide).

## Decision tree

```
Is the bulk op a pattern change? (regenerate, schedule template upsert)
  ↓ yes
  → U2: emit ScheduleUpserted (extend coverage; already in catalog)
  → Default until a consumer needs row-level state. Then revisit.

Is the bulk op a set of pattern deviations? (setHolidays, exception application)
  ↓ yes
  → U3: emit per-deviation events (HolidayMarked, ExceptionAdded)
  → Pair with U2 for the underlying pattern.

Is the bulk op truly per-row with no pattern? (rare in scheduling-api; common in admissions)
  ↓ yes
  → Is N < threshold (proposed: 100)?
      → A: per-event envelopes
  → Is N >= threshold?
      → Does any consumer need row-level fidelity?
          → no  → C (don't emit) or U1 (JIT — reduces N at the source long-term)
          → yes → D (rate-cap) if side-effect consumer; B (re-fetch) if read-model consumer
```

For the **specific scheduling-api decision**, the tree resolves to:

- **`SchedulesService.upsert`**: U2 — already emits `ScheduleUpsertedV1`; keep that, don't add per-row.
- **`CalendarEventsService.regenerate`**: U2 — emit `ScheduleUpserted` (or a peer `ScheduleRegenerated` if the semantic is meaningfully different) once per affected schedule. **Don't** emit per-row.
- **`CalendarEventsService.setHolidays`**: U3 — emit one `HolidayMarkedV1` per holiday date; the EXDATE addition + the HOLIDAY row both summarize as the deviation event. Future consumer wanting the underlying cancellation rows can derive from pattern + deviation.
- **Single-row mutations** (`cancelEvent`, `createManualEvent`, etc.): A — per-event envelopes; this is what `CalendarEventCreated` / `CalendarEventCancelled` are for.

## Threshold

Proposed default: **100 events per bulk transaction.**

Rationale: relay default rate is ~100 msg/s, so a 100-event burst drains in ~1s; outbox table holds 100 extra rows briefly; consumers see eventual consistency within ~1s. Sub-perceptual lag, no broker pressure, no operational concern. Above ~100 the questions in the decision tree start to matter.

Adjustments:
- Lower (~25) if relay throughput is constrained (small instance, slow consumers)
- Higher (~500) if relay is provisioned generously and consumer drain is verified

The threshold isn't load-bearing once U2/U3 absorb the *common* bulk paths — most "bulk" operations in scheduling-api express as pattern changes or deviation events, leaving small-N residual that A handles.

## Deferred sub-decisions

These were Open Questions in the PENDING draft. With the resolution above, they break down as follows:

1. **Threshold value (100/txn)** — accepted as starter. Codify in `@saga-ed/soa-event-outbox` docstring or `claude/event-driven-conventions.md` so the next adopter inherits it; revisit if real broker / db-host capacity numbers in dev or prod show ~100 is too high or too low.
2. **U1 (JIT materialization)** — does not get pursued from this decision. It's a real architectural improvement (memory, agility, faster pattern changes), but driven by reasons beyond event-emission. If a future reason to pursue it surfaces, it gets its own decision doc; this doc closes without it.
3. **B vs C vs D for high-N residual** — explicitly deferred to the future trigger above. If/when reopened, the residual section already documents the tradeoffs; the work then is consumer-profile assessment, not architectural design.
4. **Per-deviation events for `setHolidays`** — resolved as U3. The per-holiday event has standalone audit value (the holiday log is the holiday log) and pairs naturally with U2 for the pattern.

## Implementation follow-ups

- **`@saga-ed/scheduling-events` extensions** — open an issue against `program-hub` to add:
  - `HolidayMarkedV1 { scheduleId, date, reason?, appliedAt }`
  - Optionally `ScheduleRegeneratedV1` if the semantic is meaningfully distinct from `ScheduleUpsertedV1` (likely yes — regenerate vs upsert convey different intent)
- **Wire the publishers** in scheduling-api:
  - `regenerate()` → emit `ScheduleUpserted` (or `ScheduleRegenerated`) once per affected schedule, not per-row
  - `setHolidays()` → emit `HolidayMarkedV1` per date; cancel rows + EXDATE additions still happen as DB ops but produce no per-row events
- **Threshold codification** — add `MAX_PER_TXN_BURST_HINT` (or similar) to soa-event-outbox docstring + `event-driven-conventions.md`
- **Update `tasks/lateral-propagation.md` § 1.4** — flip from 🔵 decision-shipped to 🟢 shipped (this commit)
- **Update `d-publisher-migration.md` § 4** — already points at this doc; rewrite the recommendation paragraph to reflect the resolved cuts (this commit)
