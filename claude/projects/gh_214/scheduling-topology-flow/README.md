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
- `02-flow-design.md` — the concrete flow scenario + expected behavior + assertions. _(next — pending a design decision, see 01 §8)_

## Status
**Step 1 (understanding) complete** — `01-understanding.md` synthesizes three code deep-dives
into the oracle (what correct A/B-treatment→session behavior is) + the observable assertion
surfaces. **Key finding:** the multi-rotation slot-scoped A/B-treatment→session path is
contract- and engine-supported but **not seeded or tested end-to-end today** (the VARIES
modeling gap / saga-dash#226) — so this flow is net-new coverage and likely drives closing
that gap. Next: pick the flow scenario (`01-understanding.md` §8 open decisions) → `02-flow-design.md`.
