# 03 — Run results: scheduling-topology (A/B `varies_by_day_type` → sessions)

> The reveal run, executed 2026-07-05 on the saga-stack-cli slot-1 sub-stack
> (`node bin/dev.js e2e run saga-dash/scheduling-topology --set topo --headless`).
> **Outcome: GREEN.** The non-trivial A/B topology realizes CORRECTLY end-to-end;
> the flow now asserts that realization explicitly. This doc records what went
> green, the concrete realization proof, and where reality DIVERGED from
> `02-flow-design.md`. Parent: soa#214 · tracker: soa#221 · related: saga-dash#226.

---

## 1. Result summary

`1 passed` (two consecutive clean full-reset runs, ~13–14s each). The flow stands
up `iam-api + programs-api + scheduling-api + sessions-api + saga-dash` (closure of
5), self-seeds the scenario from stock `profile: roster`, and asserts the realized
sessions. Mint shape observed: **ANCHOR (remint path)** on every run.

## 2. The realized topology (verified live, not just page-rendered)

Program under the Empty Org, one period `varies_by_day_type` rotationCount 2,
`SAME_EVERY_WEEK` schedule, term = next Monday (M0) .. M0+6wk. Rotation A = Mon/Wed,
Rotation B = Fri. `podX` in BOTH rotations, `podY` in Rotation A only. Pod
assignments: podX→slotA=CONNECT, podX→slotB=NON_TUTORED, podY→slotA=CONNECT.

Realized sessions read back through `sessions.dayList` (the composed read model),
per oracle date:

| Date (2026) | Weekday | podX | podY | slot | treatment (wire) |
|-------------|---------|:----:|:----:|------|------------------|
| 07-06 | Mon | 1 | 1 | slotA | **CONNECT** |
| 07-07 | Tue | 0 | 0 | — | — |
| 07-08 | Wed | 1 | 1 | slotA | **CONNECT** |
| 07-09 | Thu | 0 | 0 | — | — |
| 07-10 | Fri | 1 | **0** | slotB | **NON_TUTORED** |

The **A/B switch is emergent and correct**: the *same pod* (podX) carries `slotA`/
`CONNECT` on Mon/Wed and `slotB`/`NON_TUTORED` on Fri; `podY` (Rotation A only)
never realizes on Friday (per-pod isolation holds); no pod renders >1 card on any
meeting day. These are the exact assertions in `scheduling/topology-ab.e2e.test.ts`
step 5 (`slotId`, `treatmentKind`, date, per-pod count, `viewerPermissionContextGroup
= EMPTY_ORG_ID`).

## 3. Concrete assertion surface (what the spec proves)

- **R1 (topology):** exactly **2 real slots** for the period, one per `rotationIndex`,
  distinct ids. Shape-conditional (anchor vs rrule) — see §4.1.
- **R2 (the A/B switch):** podX `treatmentKind` = `CONNECT` on Mon/Wed, `NON_TUTORED`
  on Fri, each on the matching `slotId`. **Green.**
- **R3:** podX has 0 sessions Tue/Thu. **Green.**
- **R4:** one card per pod per meeting day (`Set(podIds).size === sessions.length`).
  **Green.**
- **R5:** the read surfaces the **wire** enum (`CONNECT`/`NON_TUTORED`), not the
  Prisma `TUTORING`. **Green.**
- **Per-pod isolation:** podY meets Mon/Wed, absent Fri. **Green.**

## 4. Divergences from `02-flow-design.md` (record these)

### 4.1 The mint shape is ANCHOR, not RRULE — and that is correct
The design doc's §2/§3b.4 anticipated per-rotation slots carrying **sub-RRULEs**
(`BYDAY=MO,WE` / `BYDAY=FR`). Reality: the reactive remint
(`scheduling-api/event-handlers/programs-projection.ts remintPeriodFutureSlots`)
**soft-deactivates** the period-scoped `MO,WE,FR` rule and mints one **ANCHOR** slot
per rotation — `rrule=''`, `dtstart=today`, and a **`manual_addition` per future
occurrence date** (emitted as `ManualAdditionSetV1` + `OccurrenceTimeOverrideSetV1`
carrying the 15:00–16:00 window). sessions-api projects these into
`manual_addition_ref` + `occurrence_time_override_ref`; `expandSchedule` composes an
occurrence from the manual_addition even with no rrule. **An anchor slot is a REAL
slot, not a placeholder** — so R1's "real slot" test must key on `dtstart !== ''`, not
on the rrule. The spec accepts BOTH shapes; only ANCHOR was observed for the
weekday-`varies_by_day_type` + `SAME_EVERY_WEEK` path.

### 4.2 ANCHOR sessions surface in dayList's `adhoc` bucket, not `periods`
`dayList` splits its payload into `periods` (rule-origin, grouped) and a flat `adhoc`
bucket. Because every anchor occurrence carries **`origin: 'manual_addition'`**,
sessions-api routes these rotation sessions to **`adhoc`**, never into a `periods`
group. The design doc's §4 assertion (`periods.flatMap(p => p.sessions)`) therefore
saw **zero** sessions despite a fully correct realization. **Fix:** the spec's
`dayListSessions` unions BOTH buckets. This is a genuine presentation-layer finding
for saga-dash#226 — the realized data is correct, but a UI that reads only `periods`
would not show these rotation sessions.

### 4.3 Upsert-first ordering does NOT fully close the lost-update race
`02` §3b.4 / the earlier run-2 finding prescribed `schedules.upsert` **before**
`setRotationConfig` to guarantee the remint. Run-3 showed this is **necessary but not
sufficient**: the rotation-config consumer projects the new config yet **skips its
remint** when the just-committed `Schedule` row is not visible to that consumer's
transaction (`programs-projection.ts` guard `scheduleRow.rows.length === 0 → return`).
The period then stays **stuck on the single period-scoped `MO,WE,FR` slot — a STABLE
wrong state** (config projected, schedule present, but only 1 slot, no A/B). **Fix:**
re-emitting the identical config bumps `source_ts` past the idempotency guard and
re-runs the remint with the schedule reliably visible, minting the 2 anchor slots
(verified: a manual re-apply healed a stuck period 1→2). The spec now **re-applies
`setRotationConfig` until 2 real slots appear** (R1 self-heals). This is a sharper,
reproducible restatement of the emission/projection race for saga-dash#226.

## 5. What this proves for #221 / #226

The weekday-`varies_by_day_type` A/B path **works end-to-end today** — contrary to
the design doc's cautious "R1 may be red" hypothesis, the rotation-managed
`SAME_EVERY_WEEK` remint mints per-rotation slots and sessions realize with the
correct per-weekday treatment switch. The two real gaps this flow now pins are
NOT in the core realization but at its edges: (a) rotation sessions are only
reachable via the `adhoc` bucket (§4.2), and (b) the remint has a schedule-visibility
race that can strand a period at 1 slot until the config is re-applied (§4.3). Both
are net-new, reproducible reproductions carried in the spec.

## 6. Deliverables (shipped)

- saga-dash branch `flow/scheduling-topology` (was `…-ab`): `flows.json` (merged with
  main's journey/ads-adm/connect flows), Playwright `scheduling-topology` project, and
  the green spec `apps/web/dash/e2e/scheduling/topology-ab.e2e.test.ts`.
- Run driven from the primary `~/dev/soa` saga-stack-cli against slot-1 set `topo`.
