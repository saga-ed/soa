# synthetic-dev-align — converging local synthetic-dev onto the canonical seed-ids base

Workspace for understanding and (eventually) executing **Seth Paul's
convergence plan**: align the local `synthetic-dev` stack
(`~/dev/soa/tools/synthetic-dev`) onto the deterministic
`@saga-ed/*-seed-ids` base, while keeping the scenario runner as the
**journey** layer on top.

The motivating artifact is **saga-dash PR
[#152](https://github.com/saga-ed/saga-dash/pull/152)** ("docs: seed-ids
onboarding, local mesh runbook & synthetic-dev convergence", author
`SethPaul`) — three docs-only files that (1) document the canonical
seed-ids packages, (2) give a manual local-mesh runbook, and (3) propose
the synthetic-dev convergence as a **draft for discussion**.

## What this initiative is

A **research / synthesis** track, not (yet) an implementation track. The
goal is to:

1. Capture Seth's plan and the canonical seed-ids design faithfully.
2. Map it against the **current** synthetic-dev flow (scenario-runner
   seeding, the drift log, `up.sh`/`bootstrap.sh`/`verify.sh`).
3. Surface the seam, the layered target model, the proposed changes, and
   the open questions — so a decision to execute can be made with eyes
   open.

The convergence itself (editing `up.sh`'s seed phase, making scenarios
seed-ids-aware, stabilizing the dev user, updating `verify.sh`) is
**downstream** of this synthesis and gated on the open questions in
Seth's convergence doc.

## The one-line thesis

> synthetic-dev today seeds via the **scenario runner** → non-deterministic
> UUIDs → re-login after every `--reset`, and **local diverges from
> preview/CI** (which restore deterministic `db:seed` canonical
> snapshots). Re-point synthetic-dev's **base** at the seed-ids `db:seed`
> and make scenarios reference the canonical IDs, and you get
> **local == preview == CI** with no base re-login churn — scenarios stay
> first-class as the journey layer.

## Layout

```
claude/projects/synthetic-dev-align/
├── CLAUDE.md            # this file
├── source/              # raw source material — Seth's PR #152 docs (snapshot), threads, prompts
└── research/            # synthesized analysis of the plan + the convergence gap
```

Same shape as `soa/claude/projects/soa_75/` (the data-side track this
ultimately serves) and `student-data-system/claude/projects/sds_92/`.

## Source artifacts

In `source/`:

- `pr-152-seed-ids-onboarding.md` — Seth's seed-ids reference + ID
  inventory (the three published `0.1.0-dev.0` packages).
- `pr-152-seed-ids-local-mesh-runbook.md` — Seth's manual mesh bring-up
  + the offline correlation proof (the centerpiece).
- `pr-152-seed-ids-synthetic-dev-convergence.md` — Seth's **draft**
  convergence proposal (the target of this initiative).
- `pr-152-meta.md` — PR title / author / What-Why-Notes, captured from
  `gh pr view`.

> These are a **snapshot** of PR #152 as of capture; the canonical live
> copies are in `saga-dash/docs/` on branch `docs/seed-ids-onboarding`.
> Trust the live PR if they diverge.

## Research

In `research/`:

- `01-seth-plan-synthesis.md` — what Seth is proposing, distilled: the
  seed-ids design, the layered base/journey model, the four proposed
  changes, and the payoff.
- `02-current-synthetic-dev-flow.md` — how synthetic-dev seeds **today**
  (scenario runner), its drift log, and exactly where the seam is.
- `03-convergence-analysis.md` — the gap analysis, a side-by-side of the
  two seeding worlds, the open questions, risks, and a recommended
  sequencing with a confidence read.

## Key external references

- **Canonical seed-ids packages** (published `0.1.0-dev.0` to
  CodeArtifact `saga_js`):
  - `rostering/packages/core/iam-seed-ids`
  - `program-hub/packages/core/program-seed-ids`
  - `program-hub/packages/core/content-seed-ids`
- **synthetic-dev tool:** `~/dev/soa/tools/synthetic-dev/`
  (`README.md` = service map + drift log; `getting-started.md` =
  onboarding + verbs; `STATUS.md` = first-run handoff).
- **Data-side track (independent but adjacent):**
  `~/dev/soa/claude/projects/soa_75/` — outbox / event-driven projections
  POC. seed-ids = **seed-time** agreement; events = **runtime**
  propagation. The two are complementary.
- **Original seed/scenario vocabulary:**
  `rostering/claude/seed-scenario-handoff.md`.

## Decision docs — rule of thumb

Inherits the repo-root convention: any decision surfaced for the user's
review goes here as a markdown doc under a `decisions/` subdir (created on
demand — not pre-seeded). Topic-first naming, `PENDING` at top until
resolved (flip to `RESOLVED <date>` with a one-line summary). Each doc
carries Context / Options / Recommendation / Related artifacts.

The most likely first decision: **whether and when to execute the
convergence**, and **how to split base vs journey rows** (Seth's open
questions). Don't bury that in chat — write the doc.

## Conventions

Inherits from `~/dev/soa/CLAUDE.md`:

- pnpm only (never npm/yarn)
- ESM only (`"type": "module"`)
- TypeScript strict mode
- The seed-ids contract is frozen: `ROOT_NAMESPACE = b2c4f1a0-…`,
  `CANONICAL_SOURCE = 'canonical'`. **Never** change the namespace — it
  re-randomizes every ID and breaks every consumer.

## Branch state

- Repo: `soa`, branch `main` at initiative bootstrap.
- This is a docs/research-only initiative; no code changes land here
  until the convergence is approved (then it touches
  `tools/synthetic-dev/` + `rostering`/`program-hub` `scripts/scenarios`).

---

*Last updated: 2026-06-04 (initiative bootstrap)*
