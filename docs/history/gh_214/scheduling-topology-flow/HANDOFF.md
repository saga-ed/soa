# HANDOFF — scheduling-topology flow (A/B treatments → sessions)

> Paste this to a fresh agent to continue the effort. It is self-contained. The
> "understanding" step is **done**; your job is to **design, seed, author, and run**
> the flow. Another terminal is concurrently doing the M7 ultracode on the SAME soa
> branch (`gh_214`) — read **§Coordination** before you touch `~/dev/soa`.

## Mission
Author **the second `flows.json` scenario** for **saga-stack-cli**: a backend-focused e2e
flow that stands up only `scheduling-api` + `sessions-api` (the N-of-M sub-stack the CLI
makes cheap), builds a **complex schedule with an A/B switch between two treatments**
(Kevin Zhang's rotation work), and verifies **how sessions realize** — proving (or
revealing where it breaks) that each date's session carries the correct rotation slot +
`treatmentKind`.

Tracker: soa **#221** (the saga-stack-cli ToDo — "Flow content → new scenarios" line item;
this is "New flow #1"). Parent effort: soa **#214**.

## START HERE (required reading, in order)
1. `claude/projects/gh_214/scheduling-topology-flow/01-understanding.md` — **the oracle**.
   Code-grounded: what an "A/B switch between treatments" is, how sessions realize
   (read-time pure function), where treatment resolves per session, the assertion
   surfaces, and — critically — **§5 THE GAP** and **§8 open decisions**.
2. `README.md` (same folder) — framing + status.

## Decisions already made by skelly (LOCKED — build to these)
- **Target = "purpose-built A/B seed, reveal reality"** (01 §8 option c/a hybrid). Author a
  real 2-rotation A/B schedule (slot-scoped rules, differing treatments) via a purpose-built
  seed + the actual APIs, run the flow, and let it show how far the real path gets —
  **red-until-fixed if it breaks**. This is net-new coverage that likely drives closing the
  VARIES modeling gap / saga-dash#226. Do NOT scope down to "what works today."
- **First rotation pattern = `varies_by_day_type` (weekday-driven).** Concrete target
  scenario to build the oracle around:
  - One period, `rotationCount = 2`, `rotationPattern = varies_by_day_type`.
  - **Rotation A** = Mon/Wed, `treatmentKind = CONNECT` (tutored).
  - **Rotation B** = Fri, `treatmentKind = NON_TUTORED`.
  - One pod assigned to BOTH rotations (its treatment alternates by weekday).
  - **Expected realized sessions** (the assertion): a Monday/Wednesday occurrence → a
    session with that pod, `slotId` = rotation-A's slot, `treatmentKind = CONNECT`; a Friday
    occurrence → `slotId` = rotation-B's slot, `treatmentKind = NON_TUTORED`; no session on
    Tue/Thu; exactly one card per pod per meeting day.
  - `split_period` (intra-day) and `custom` (date-map) are explicit FOLLOW-ONS, not now.

## The plan (your work)
1. **§02 — flow design doc** (`02-flow-design.md`): pin the exact scenario above into a
   precise oracle table (date → expected {slotId/rotation, treatmentKind, podId, count}),
   choose the **seed strategy** (see §Seed below), name the assertion surface + exact tRPC
   calls, and list what "reveal reality" means (which assertions are expected to pass vs
   which may go red and why — cite the gap). Get this reviewed before mass-authoring.
2. **Purpose-built A/B seed.** Create a deterministic seed that produces the 2-rotation
   varies_by_day_type schedule end to end. Decide (and document) **API-built vs
   direct-projection** (01 §8 Q3): prefer **API-built** (`programs-api setRotationConfig` +
   `scheduling-api schedules.upsert` + `PodAssignment`s) so the real
   emission→projection→read path is exercised (this is where the gap lives and what you want
   to reveal); fall back to a direct sessions-api projection seed only to isolate the read
   engine if the API path is too broken to bootstrap. Live in the scheduling-api /
   sessions-api / program-hub seed infra (`~/dev/program-hub/apps/node/{scheduling-api,
   sessions-api}/src/prisma/seed*.ts`), or a dedicated fixture the flow's seed step invokes.
3. **Author the `flows.json` entry + the spec.** The real per-SPA `flows.json` does NOT yet
   exist in the saga-dash repo (only the bundled example in saga-stack-cli). Add the flow to
   `~/dev/saga-dash/apps/web/dash/e2e/flows.json` (create it — this also advances the #221
   "author real flows.json" item) with the backend-focused shape in 01 §7. Write the spec
   `apps/web/dash/e2e/scheduling/topology-ab.e2e.test.ts` using the **tRPC-direct `rpcGet`**
   pattern from the journey stage-5/6 tests (assert `sessions.dayList` on the chosen
   occurrence dates; optionally assert `slot_projection`/`pod_assignment_projection` in the
   DB for topology).
4. **Run it via the CLI + reveal.** `ss stack up --only scheduling-api,sessions-api` for the
   sub-stack; then `ss e2e run saga-dash/scheduling-topology`. Capture what passes and what
   goes red; the red assertions ARE the finding — document them (they scope the gap/fix).

## Seed / correctness facts you'll need (from 01)
- **Sessions are NOT materialized** — realized read-time (`expandSchedule → composeTutoringSession`).
  `treatmentKind` is read **verbatim** from the firing slot's `pod_assignment`. Assert via the
  **read API**, not a session table.
- **One slot per `(period, rotation)`**; each rotation's slot has its own recurrence rule +
  its own `pod_assignment.treatmentKind`. The date selects which rotation's slot fires.
- **`projection_readiness`** is a fail-closed warmth gate — WAIT for warmth (poll) or reads
  mask to 0 (false green). The journey polls with `expect.poll`, never sleeps — do the same.
- **Term dates are mandatory** — without both, the slot stays a blank `rrule=''` placeholder
  that drives nothing.
- **treatmentKind is triple-cased** — assert the **wire** value (`CONNECT`/`NON_TUTORED`) from
  the API; DB stores `TUTORING`/`NON_TUTORED`.
- **Day-type join is name-fragile** (`schedulingDayTypeId` inert today) — but weekday-driven
  `varies_by_day_type` (our pick) routes by weekday, sidestepping that; still seed names
  consistently.
- Actor precedent: journey uses the **Empty Org admin** (`empty@saga.org`) + the
  `sessions:lifecycle_non_hosted_sessions` grant seeded by `seedEmptyOrgAdminAuthz` — reads
  mask to 0 without it. Reuse or replicate that authz seed.
- Full assertion-surface list + `SessionView` fields: 01 §6.

## Coordination / isolation (IMPORTANT)
- **Another terminal owns `~/dev/soa` on branch `gh_214`** for the M7 ultracode (editing
  `packages/node/saga-stack-cli/**`, uncommitted work in flight). To avoid clobbering it,
  **isolate any soa work in a git worktree**: `git -C ~/dev/soa worktree add
  .claude/worktrees/scheduling-topology gh_214` and do your soa docs/commits there — OR only
  commit path-scoped docs and never `git checkout`/reset the shared soa working tree.
- **`~/dev/program-hub` and `~/dev/saga-dash` are yours** — the M7 terminal is not touching
  them. The flow's real deliverables (seed + `flows.json` + spec) live there.
- The `flows.json` goes in the **saga-dash repo**, not saga-stack-cli — so it does not
  conflict with M7. (If you want the CLI to resolve it, the `spa-registry` repo-file
  preference is an M8 item; for now `ss e2e run` can use the bundled example or the repo file
  per the resolver.)
- Commit your soa design docs to `gh_214` (the effort branch); commit seed/spec to their
  repos' branches. Update this folder's `README.md` status + the #221 "New flow #1" item as
  you progress.

## Deliverables
1. `02-flow-design.md` (oracle table + seed strategy + assertions + reveal plan).
2. A deterministic purpose-built A/B `varies_by_day_type` seed.
3. `saga-dash/apps/web/dash/e2e/flows.json` (+ the `scheduling-topology` flow entry) and the
   spec `.../e2e/scheduling/topology-ab.e2e.test.ts`.
4. A run report: what realized correctly, what went red, and (if red) a crisp statement of
   the gap it exposes — feed that back to #221 / saga-dash#226.

## Repos & key paths
- scheduling-api: `~/dev/program-hub/apps/node/scheduling-api` (`src/services/schedules.service.ts`, `rotation-config-match.ts`, `src/prisma/{schema.prisma,seed.ts}`).
- sessions-api: `~/dev/program-hub/apps/node/sessions-api` (`src/sectors/sessions/*`, `src/event-handlers/*-projection.ts`, `src/prisma/{schema.prisma,seed.ts}`).
- programs-api: `~/dev/program-hub/apps/node/programs-api` (`src/services/periods.service.ts` — `setRotationConfig`).
- saga-dash e2e: `~/dev/saga-dash/apps/web/dash/e2e/` (journey/{schedule,sessions}.e2e.test.ts + fixtures/lane.js + data/roster-reset.js).
- flow model + CLI: `~/dev/soa/packages/node/saga-stack-cli/src/core/flow/types.ts`, `examples/flows/*.flows.json`, `examples/flows/README.md`.
- shared libs: `~/dev/program-hub/packages/node/{schedule-expansion,session-composition,programs-events,program-hub-types}`.
