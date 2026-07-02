# Scheduling-topology flow — complex schedules → sessions (A/B treatment switches)

A **second `flows.json` scenario** for saga-stack-cli: a backend-focused e2e flow that
stands up **only `scheduling-api` + `sessions-api`** (the N-of-M sub-stack the CLI makes
cheap), builds a **complex schedule** exercising **Kevin's scheduling-topology work —
specifically A/B switches between different treatments** — and verifies **how sessions
realize** in the presence of that schedule.

This is the concrete instance of the "author *new* flow scenarios" work.

## Tracking
- **Parent effort:** saga-ed/soa **#214** — "OCLIF CLI for synthetic-dev" (saga-stack-cli).
- **Work-item tracker:** saga-ed/soa **#221** — the saga-stack-cli ToDo/findings issue,
  under the **"Flow content → author new scenarios"** line item. (The various bits of
  CLI work are captured on #221; #214 is the umbrella.)

## Approach (in order)
1. **Comprehensive understanding FIRST** (this step). Develop a rigorous, code-grounded
   understanding of: the scheduling domain model + topologies, what an "A/B switch
   between treatments" is and how it's modeled (Kevin's work), how a schedule **projects
   into sessions**, and the **observable surfaces** an e2e can assert against. Output:
   `01-understanding.md`.
2. **Flow design** — pick the concrete complex-schedule scenario(s) to exercise, the
   expected realized-sessions (the oracle), and the assertion surface. Output:
   `02-flow-design.md`.
3. **Author** the `flows.json` entry + the spec(s)/stage(s), then run it via the CLI.

## Contents
- `README.md` — this file.
- **`HANDOFF.md`** — self-contained prompt for a fresh agent to continue this effort
  (design → seed → author → run). Decisions locked: purpose-built A/B seed (reveal
  reality); `varies_by_day_type` weekday pattern first. **Read this to pick up the work.**
- `01-understanding.md` — the synthesized understanding (from parallel code research). ✅ **done**
- `02-flow-design.md` — the concrete flow scenario + expected behavior + assertions. ✅ **drafted (review gate)**

## Status
**Step 2 (flow design) drafted — awaiting review.** `02-flow-design.md` pins the locked
scenario (weekday `varies_by_day_type`, Rotation A=Mon/Wed=`CONNECT`, B=Fri=`NON_TUTORED`,
one pod in both) into a precise oracle table, the **API-built** build sequence (exact tRPC
calls: `periods.update`/`setRotationConfig` → `schedules.upsert` → poll `slots.list` →
`podAssignments.upsert` → assert `sessions.dayList`), the assertion surface, and a **reveal
plan** (R1 "does the weekday variant mint 2 slot-scoped slots" is the hinge — green = net-new
proof, red = a sharper restatement of saga-dash#226). Step 1 (understanding) remains the
oracle: the multi-rotation slot-scoped A/B path is contract/engine-supported but **not seeded
or tested end-to-end today** (VARIES modeling gap / saga-dash#226). Next: review `02` §7 open
questions → build seed + `flows.json` + spec → run + reveal.
