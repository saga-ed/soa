# 03 — Convergence analysis: the seam, the risks, the sequencing

> Builds on `01-seth-plan-synthesis.md` (the plan) and
> `02-current-synthetic-dev-flow.md` (the baseline). This is the
> synthesis: where exactly the two worlds meet, what's hard, and a
> recommended order of operations. **My read, marked with confidence.**

## The seam, stated precisely

There is exactly **one** mechanism to change: **how synthetic-dev builds
its base roster.**

- **Today:** `up.sh --seed roster` → scenario runner → IDs assigned at
  create time → non-deterministic → re-login after every `--reset`,
  local ≠ preview/CI.
- **Target:** `up.sh` base phase → each service's `pnpm db:seed` →
  `uuidv5(slug)` derived IDs → deterministic → no base re-login, local ==
  preview == CI.

Everything else Seth proposes (scenarios become seed-ids-aware,
`AUTH_DEVUSERID` stabilizes, `verify.sh` asserts the catalog) is
**downstream of** or **enabling for** that single swap.

## Why this is low-conceptual-risk

Three things make this less scary than a typical seeding rewrite:

1. **Same roster, same numbers.** Both paths describe the *identical*
   synthetic roster (5/13/28/168/22/6, 9 programs, 12 content). Seth's
   convergence doc and synthetic-dev's own counts agree. We're not
   changing *what* exists, only *which UUIDs* it gets and *who* writes it.
2. **`up.sh` is already half-converged.** Drift #10 already moved DB
   provisioning to `prisma migrate deploy` — "the same command
   program-hub's ECS `migrate` job runs." Switching the *seed* step to
   `db:seed` extends an existing posture (mirror the deployed path), it
   doesn't invent one.
3. **The packages are published and proven.** All three seed-ids packages
   are `0.1.0-dev.0` on CodeArtifact; the runbook's Step 5 correlation
   proof is grounded and runnable. The base layer already works in
   preview/CI. We're importing a known-good base into local.

## Where the real work / risk sits

### R1 — base/journey split is not yet drawn (the crux)

The scenario runner today creates **both** base and journey rows in one
pass. The convergence requires cleanly separating them:

| Likely **base** (move to `db:seed`) | Likely **journey** (stays in scenario) |
|---|---|
| districts, schools, sections | enrollments |
| users + PII + password auth | schedules / recurrence rules |
| memberships (the ~593) | sessions |
| programs, periods | attendance flows |
| content items | per-run dynamic state |

The boundary is *mostly* obvious (enrollment = journey; programs/periods =
base) but **memberships and personas are the ambiguous middle** — see R2.
**Confidence: high** that the split is doable; **medium** on where exactly
memberships/personas land without reading the scenario source.

### R2 — base parity / persona gap (Seth's open Q1)

Does `db:seed` cover everything the scenario base covers *today*?

- The scenario base produces **197 users / 46 groups / 593 memberships**
  and per-district admin **personas**.
- seed-ids `db:seed` seeds users + PII + password auth + memberships, but
  Seth flags that **per-district admin personas for
  riverside/metro/oakdale/frontier were a noted seed-ids follow-up.**
- If those personas aren't in `db:seed` yet, login parity breaks for the
  non-`seed`-district personas after convergence. **This is the single
  most important thing to confirm before flipping `up.sh`.**

**Action:** diff the scenario's produced user/membership/persona set
against what `db:seed` produces, per district. If there's a gap, it's a
seed-ids package PR (add the missing personas to `catalog.ts`), not a
synthetic-dev change — which keeps the fix where the contract lives.

### R3 — dev-user identity flip (drift #5 ↔ proposed change 3)

> **Corrected by `04-parity-audit.md`:** `f0000004-…-beef` is **not** the
> scenario's dev user — it's from a *separate* standalone seeder
> (`iam-db/src/seed-dev-user.ts`, email dev@**example**.org) that `up.sh`
> runs alongside the scenario. The scenario's `dev@saga.org` gets a
> server-random UUID. So synthetic-dev today already juggles two "dev"
> identities.

Target is `userId('dev')` = `1e2ca0d8-…-1186` (dev@saga.org, carries
password auth). Proposed change 3 actually **removes** the existing
two-identity ambiguity → a simplification, not just a flip. Still a
**coordinated** change (env var + retire the `…beef` seeder + any saga-dash
reference move together), but lower risk than first framed. Email-based
devLogin (`dev@saga.org`/`password123`) keeps working throughout.

### R4 — scenario refactor scope (Seth's open Q3)

Making scenarios "reference seed-ids instead of mint" touches `rostering`
+ `program-hub` `scripts/scenarios`. Unknown until the source is read how
deeply IDs are threaded. Two sub-risks:
- Scenarios import the **browser-safe root** vs the **`/derive` subpath**
  — must pick correctly (Node context → can use either; the catalog
  literals are fine).
- A `--seed full` verb that = `db:seed` base + scenario journey needs the
  scenario to be **idempotent against an already-seeded base** (today it
  assumes it owns creation). Re-running must not double-create or
  collide on the now-fixed base UUIDs.

### R5 — "iam groups don't dedup" (existing footgun)

synthetic-dev's README already warns: `--seed roster` without `--reset`
duplicates iam groups (no dedup). With deterministic `db:seed` UUIDs +
`upsert` on fixed ids (the producer pattern uses `prisma.group.upsert`
keyed on `deriveGroupId(slug)`), this footgun **goes away** for the base —
a genuine secondary benefit. **Confidence: high** (the onboarding doc's
§4b shows the upsert-on-derived-id pattern explicitly).

## Side-by-side: before vs after

| Dimension | Today (scenario base) | After convergence (db:seed base) |
|---|---|---|
| Base seed mechanism | scenario runner | each service `pnpm db:seed` |
| Foundational UUIDs | non-deterministic | deterministic `uuidv5(slug)` |
| After `--reset` | new UUIDs → **re-login** | identical UUIDs → **no base re-login** |
| local vs preview/CI | **diverges** | **identical by construction** |
| Dev user | `…beef` + separate seeder | `userId('dev')` = `1e2ca0d8-…` |
| iam group re-seed | duplicates (no dedup) | upsert on fixed id → idempotent |
| Scenarios | create base + journey | reference base, create journey only |
| `verify.sh` base check | row counts | row counts **+ ID assertions** |

## Recommended sequencing

A safe, reversible order — each step independently verifiable, no big-bang:

1. **Parity audit first (no code).** Diff scenario-produced
   users/groups/memberships/personas vs `db:seed` per district. Output:
   a gap list (R2). *This is the gating artifact — everything else waits
   on it.* → if gaps exist, file seed-ids package PR(s) to close them.
2. **Stand up a `db:seed` base by hand** following the runbook Steps 1–5
   on the synthetic-dev mesh; confirm the Step 5 correlation proof passes
   locally. Validates the base works against *our* infra before touching
   `up.sh`.
3. **Add `up.sh --seed base` (new verb, additive).** Runs `db:seed` for
   iam-db / programs-api / scheduling-api (+content when present). Leave
   `--seed roster` (scenario) intact alongside it. Now both paths exist;
   nothing breaks.
4. **Stabilize the dev user** (`AUTH_DEVUSERID=userId('dev')`, retire the
   `…beef` seeder) — but only once `--seed base` is the default base.
5. **Make scenarios seed-ids-aware** + add `--seed full` = base + journey
   (R4). Scenario stops minting foundational IDs.
6. **`verify.sh` ID assertions** — assert `deriveGroupId('seed')` etc.
   match the DB, plus the catalog counts.
7. **Flip the default** (`bootstrap.sh` → `--seed base`/`full`) and update
   STATUS/README/getting-started. Retire `--seed roster` (scenario base)
   once parity is proven.

Steps 1–2 are pure validation; steps 3–6 are additive and reversible;
step 7 is the only one-way door, and it comes last with parity already
proven.

## My read / recommendation

**Recommendation: pursue it — high value, and the architecture is right.**
The layered "deterministic base + scenario journey" model is the correct
shape: it fixes the genuine local≠preview divergence and the re-login
churn *without* throwing away the scenario runner's journey value. Seth's
restraint ("not delete the scenario runner," "only the base must be
stable," "no harness change") keeps the blast radius small.

- **Confidence the model is right: high.** It mirrors the deployed
  seed path (which `up.sh` already half-tracks via drift #10) and the
  packages are published and proven.
- **Confidence on effort/scope: medium.** The unknowns are all in R1/R2/R4
  — the base/journey split and persona parity — and none are conceptual,
  they just need the scenario source read and a parity diff run.
- **The one gate: R2 persona parity.** Do not flip the default until
  `db:seed` demonstrably produces login-able personas for *every*
  district the scenario base does today. That's a measurable
  precondition, and step 1 produces it.

**Lowest-regret next action:** run the step-1 parity audit and write it up
as a decision doc (`decisions/d1.1-base-journey-split.md`) — it both
unblocks the work and gives the user the base-vs-journey call to make.

## Open questions to put to the user / Seth

1. **Execute now or park?** This is a draft proposal; is converging
   synthetic-dev in scope for this cycle, or is it documentation-ahead-of-
   work? (Affects whether step 1 runs now.)
2. **Persona parity (R2)** — is the per-district admin persona follow-up
   in seed-ids already closed, or still open? If open, who owns the
   `catalog.ts` PR?
3. **Where does the convergence work land** — in `tools/synthetic-dev`
   (the harness) for steps 3/6, and in `rostering`+`program-hub`
   `scripts/scenarios` for step 5? Confirm the cross-repo split and
   branch posture (likely the same integration-suite pinning model).
4. **`--seed roster` deprecation** — keep the scenario-base verb as an
   escape hatch, or remove it once `--seed base`/`full` prove out?

## Related artifacts

- Plan: `./01-seth-plan-synthesis.md` · Baseline: `./02-current-synthetic-dev-flow.md`
- Raw source: `../source/pr-152-*`
- Live: saga-dash PR #152 (`docs/seed-ids-{onboarding,local-mesh-runbook,synthetic-dev-convergence}.md`)
- Tool: `~/dev/soa/tools/synthetic-dev/{README,getting-started,STATUS}.md`
- Adjacent track: `~/dev/soa/claude/projects/soa_75/` (events = runtime; seed-ids = seed-time)
