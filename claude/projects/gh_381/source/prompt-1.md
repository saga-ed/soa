# Session prompts — 2026-07-28 (Sean + Fable)

The questions that drove the research in `../research/`, in order. Captured so the scope of
each document is traceable to what was actually asked.

---

**1 — the opening question (→ `research/01-per-environment-seeding.md`)**

> Can you help me understand the way that demo data is setup in synthetic-dev, in the wootdev
> (dev) environment, in training and eventually in the production environment. What I want to
> know is what is currently supported in each environment and how to create a consistent set of
> demo users that exists for development use in each environment.

**2 — the template ask (→ `research/02-seed-user-structure.md`)**

> Can you create a human readable MD document that describes the seed users in synthetic-dev
> that will serve as the template of the seed user structure I want replicated across wootdev,
> training and prod.

**3 — the feasibility question (→ `research/03-pareback-feasibility.md`)**

> [Adam's proposal — see `adam-canonical-district-proposal.md`] … Now the question I have is to
> what extent does our db:seed infrastructure lend itself to different seed configurations —
> does the smaller seed structure we have described here live alongside the larger more
> organically grown one, or is changing seed to produce the smaller more canonical set
> destructive?

**4 — the blast-radius follow-up (→ `research/03-pareback-feasibility.md`, and the epic body)**

> What would be the side effect of paring back the iam `db:seed` to a more circumscribed set of
> districts? What would break downstream? Are there other seed flows that depend on the
> districts in the current catalog?

**5 — the tracking question (→ this epic)**

> Is there any issue tracking the state of our `db:seed` infra from an Epic perspective? We have
> decided not to mess with the canonical seed at this point but we do want to revisit in the
> future.

---

## Clarifications resolved along the way

Worth recording, because each was a real ambiguity that cost a round-trip:

- **`SEED_DISTRICT_ONLY` is a mode-selector env var, not a catalog entry** and not a name for
  the T1/T2/T3 set. Three separate things need names; see the epic's "Naming still to lock".
- **`SEED_DATASET` is not iam-scoped.** It is the fleet-wide *identity* axis, stampable onto any
  system. The only scenario authored (`ab-topology`) covers programs/scheduling/sessions — iam
  has no dataset because iam has only one fixture.
- **`ss e2e journey` does seed iam.** The flow declares `"seed": {"reset": true, "profile":
  "roster"}`, and the `roster` profile's `iam` step *is* `pnpm db:seed`. Empty Org is not set up
  by hand — it is seeded scaffolding (district + admin + student/tutor persona templates) that
  is deliberately empty of content. Stage 1 then authors a roster into it via real CSV upload.
  The persona templates matter: sis-api derives a district's acceptable `canonical_role` values
  from the personas on its group, so an admin-only district would reject every non-admin CSV row.
