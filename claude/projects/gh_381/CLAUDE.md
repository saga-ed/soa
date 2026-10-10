# gh_381 — `db:seed` infrastructure: state, pare-back analysis, and the silent hazards

Workspace for the fleet-wide seed layer: how every environment seeds today, what a
circumscribed "canonical" district set would cost, and the hazards that make a naive
pare-back dangerous.

- **Issue:** [saga-ed/soa#381](https://github.com/saga-ed/soa/issues/381)
- **Assignees:** Seth Paul, Nathan Neri, Sean Kelly, Adam Holt
- **Branch:** `worktree-gh381-seed-epic`

**Parent Context:** Part of [soa](../../../CLAUDE.md), the shared-infrastructure monorepo —
this is a project-scoped working doc under `claude/projects/`.

## Status — parked by decision, not by blocker

**2026-07-28: we are NOT changing the canonical seed now.** Adam's ~3-district proposal is
sound; this workspace exists so revisiting it later is a *read*, not a re-derivation. Nothing
here is in flight.

## The one-line thesis

> Paring the seed back is **safe as _selection_ and unrecoverable as _deletion_** — and the
> blocker is not in rostering at all: `programs-api`'s iam resolution degrades **all 62**
> sourceIds to mock strings when **one** group is missing, via a `console.warn`, on a code path
> that only executes in previews and never locally.

## Layout

```
claude/projects/gh_381/
├── CLAUDE.md     # this file
├── source/       # Adam's proposal + the session prompts that scoped each doc
└── research/     # the three analyses, numbered
```

## Research

| Doc | Answers |
|---|---|
| [`research/01-per-environment-seeding.md`](research/01-per-environment-seeding.md) | What synthetic-dev / wootdev / training / prod each seed, per service, with the exact migrate commands |
| [`research/02-seed-user-structure.md`](research/02-seed-user-structure.md) | The synthetic-dev seed users as a replication template — 31 loginable accounts, 35 personas, every UUID verified against the live catalog |
| [`research/03-pareback-feasibility.md`](research/03-pareback-feasibility.md) | Three-layer analysis (snapshot / seeder / catalog), the downstream blast radius, and positions on Adam's six open questions |

## The three findings that matter most

1. **`programs-api` `resolveIamIds()` is all-or-nothing and environment-dependent.** One missing
   iam group → `mockIds()` for all 62 sourceIds, warn-level. `ss` never sets `IAM_API_URL` so it
   takes the offline branch and is immune; PR previews and sandboxes do set it and are not.
   Passes locally, corrupts previews. Worth fixing on its own merits.
2. **`program-seed-ids` IDs are position-indexed** (`programId = NS + pad(findIndex + 1)`, and
   `periodId` derives from the program index). Catalog entries must never be deleted or
   reordered — only appended.
3. **The infra already supports multiple seed configurations.** Four modes coexist in
   `prisma/seed.ts` today; program-hub has a catalog-slice knob; `ss` formalizes
   dataset(identity) vs profile(quantity); snapshots accept any named profile and version
   immutably. A pare-back is a *selection* to author, not an architecture to build.

## Conventions

Inherits from [`~/dev/soa/CLAUDE.md`](../../../CLAUDE.md): pnpm only, ESM only, TS strict.

The seed-ids contract is frozen: `ROOT_NAMESPACE = b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c`,
`CANONICAL_SOURCE = 'canonical'`. **Never** change the namespace — it re-randomizes every ID
and breaks every consumer.

## Decision docs

Any decision surfaced for review goes here as markdown under a `decisions/` subdir (created on
demand — not pre-seeded). Topic-first naming, `PENDING` at top until resolved. The most likely
first ones, if this is picked back up: the **district slugs** (they fix every derived UUID, so
they must be locked before the first write) and the **prod slug + email domain**.

---

*Last updated: 2026-07-28 (workspace bootstrap; parked)*
