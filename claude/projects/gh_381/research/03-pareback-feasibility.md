# Can we pare back `db:seed` to a small canonical set — and is that destructive?

_Analysis 2026-07-28, in response to Adam's "Canonical Dev District" proposal (~3 tiered districts).
Companions: [`02-seed-user-structure.md`](02-seed-user-structure.md) (the current structure),
[`01-per-environment-seeding.md`](01-per-environment-seeding.md) (how each env seeds today)._

---

## The short answer

**It depends entirely on which of three layers you pare back — and they have opposite answers.**

| Layer | Pare back = | Coexists with the big set? | Destructive? |
|---|---|---|---|
| **1. Snapshot / profile** (`seed-profile: <name>`) | cut a second named, immutable snapshot | ✅ **yes, today, zero code change** | ❌ no |
| **2. Seeder mode** (`SEED_*` env branch) | select a catalog subset at seed time | ✅ **yes — the mechanism already exists 4× over** | ❌ no |
| **3. Catalog** (delete entries from `catalog.ts`) | remove the slugs entirely | ❌ **no** | ☠️ **yes — and worse than it looks** |

**So: the small canonical set can live alongside the organically-grown one, permanently, with no
loss — provided the pare-back is expressed as *selection* rather than *deletion*.** The
infrastructure is already built for exactly this. The only genuinely destructive move is editing
the catalog, and §3 shows it is sharper than "we lose some test districts."

Recommendation: **build the small set as a new selection over the existing catalog. Never delete a
catalog entry.**

---

## 1. Layer 1 — snapshots already support multiple named seed configurations

The deploy-time contract (`saga-iac references/sandbox-seed-profile.md`, switchboard
`models.py`) is:

| `seed-profile` value | meaning |
|---|---|
| `''` (empty) | no restore — bring the DB up empty and run the live `db:seed` |
| `'canonical'` **or any non-empty name** | restore **that** snapshot; skip the destructive live seed |
| omitted | defaults to `'canonical'` |

**"Any non-empty name" is the whole answer at this layer.** A second profile — say
`rostering-iam-minimal` — is a *new S3 prefix*, not a replacement. Both are restorable forever.

`rostering/.github/workflows/cut-canonical.yml` already supports cutting to an arbitrary
destination via its `dest-prefix-override` input, and its own header states the versioning
guarantee:

> the re-cut is non-destructive: it lands as the next immutable version (`profile-canonical-vN`)
> and advances the `profile-canonical.sql` pointer; **prior versions are retained and remain
> restorable via `<profile>@vN`**

So even within one profile name, history is immutable. Nothing is lost by cutting a new one.

**Practical consequence:** `sandbox-deploy.yml` / switchboard could offer
`seed-profile: minimal` vs `canonical` per composition **the day the snapshot exists** — no
workflow change, no code change. That is the cheapest possible coexistence and it is free today.

---

## 2. Layer 2 — the seeder already has a formal multi-configuration model

This is not something we'd be inventing. There are **four independent precedents**, three of
them in the exact files we'd touch.

### 2a. `prisma/seed.ts` already dispatches four modes

The bottom of `/home/skelly/dev/rostering/packages/node/iam-db/prisma/seed.ts` is an env-var
mode dispatcher:

```
SEED_SMOKE_FIXTURE_PHASE=iam|pii  → single-DB minimal smoke fixture   (additive)
SEED_DEMO_ONLY=1                  → seedDemoOnly()      — demo district only (additive)
SEED_REP_TRAINING_ONLY=1          → seedRepTrainingOnly() — rep-training only (additive)
(default)                         → main()              — full canonical    (☠️ destructive)
```

Four configurations of the same catalog, coexisting in one file, already shipped. **A fifth
branch — `SEED_DISTRICT_ONLY=<slug>` — is the natural extension, not a new architecture.** Every
additive path already demonstrates the required properties: upsert by derived id, deletes scoped
to its own ids, safe on a persistent shared DB.

### 2b. program-hub already has a catalog-slice knob — with the right warning attached

`/home/skelly/dev/program-hub/packages/core/program-seed-ids/src/seed-profile.ts`:

> **Seed profile — the breadth knob** … It selects **WHICH slice of the PROGRAMS catalog a seed
> run plants** … Returned in catalog order, **so callers that map to ids preserve the
> position-indexed derivation unchanged.**

That is *precisely* the pattern Adam is proposing, already implemented on the program side —
and the comment already names the hazard §3 is about. `content-api` reads `SEED_PROFILE` the
same way.

### 2c. saga-stack-cli formalizes the two axes

`/home/skelly/dev/soa/packages/node/saga-stack-cli/src/core/seed/datasets.ts` splits the problem
explicitly:

> **Dataset is IDENTITY (which fixture); profile stays QUANTITY (how much) — the axes are
> orthogonal, so a dataset never changes WHICH steps are selected, only what the selected steps
> seed.**

…and names its transport: a `SEED_DATASET=<name>` env var stamped onto a compose-time clone of
the frozen step registry — "**the house `SEED_DEMO_ONLY` pattern**". Coherence is enforced by
`composeSeedPlan`, which throws `SeedDatasetError` if a coupled scenario would be half-applied.

**So the fleet already has a vocabulary for this**: `canonical-small` is a **dataset** (identity),
not a profile (quantity). Wiring it means adding a name to a frozen registry — an append.

### 2d. What this buys us

`ss stack seed roster --dataset iam-api=canonical-small` and `ss stack seed full` can coexist on
the same machine, on different slots, from the same catalog. Nothing is lost; the big set stays
available for scale/pagination work and for the flows that already depend on it.

---

## 3. Layer 3 — catalog deletion is the destructive act, and it is sharper than expected

### 3a. ☠️ The blocker: program IDs are **position-indexed**, not hash-derived

`iam-seed-ids` uses `uuidv5("group:"+slug)` — order-independent. Removing a district there orphans
*that district's* ids and nothing else.

**`program-seed-ids` does not.** From
`/home/skelly/dev/program-hub/packages/core/program-seed-ids/src/index.ts`:

```ts
const PROGRAM_NS = 'a1b2c3d4-0001-4000-8000-';
const programIndex = (slug) => PROGRAMS.findIndex((p) => p.slug === slug);
// id = PROGRAM_NS + pad(index + 1)
```

The id **is** the array position. Delete an entry and **every program after it renumbers.**

Current catalog — 23 programs, in this order:

| # | program | org |
|---|---|---|
| 1–2 | `lincoln-fall`, `roosevelt-ab` | `seed` |
| 3 | `riverside-afterschool` | `riverside` |
| 4–9 | `metro-east` … `metro-lakeside` | `metro` |
| 10–11 | `demo-north-summer`, `demo-south-summer` | **`demo`** |
| 12–17 | `varied-rotation-abc` … `varied-full-day` | `varied-schedules` |
| 18–19 | `minimal-single`, `minimal-unmapped-draft` | `minimal-setup` |
| 20–23 | `rep-every-other-day` … `rep-concluded` | **`rep-training`** |

If we keep only Adam's three orgs (`demo` + `emptyOrg` + `rep-training`) and delete the rest:

- 17 of 23 programs removed
- the first removal is at **position 1**
- ⇒ **all 22 remaining ids move**, including all 6 programs we intended to *keep*

Every persisted `programId` in programs-api, scheduling-api, sessions-api, the three
`*_projection` mirror DBs, SDS, and every snapshot silently points at the wrong program. There is
no error — the mesh deliberately has no cross-service FKs.

**And it cascades.** Period ids are derived *from the program index*:

```ts
// periodId suffix = programIndex * 10 + periodIndex   (1-based)
export const periodId = (programSlug, periodKey) => { const p = programIndex(programSlug); … }
```

So a single deletion at position 1 moves **every program id and every period id in the catalog**.
Periods are what schedules, `period_meeting` rows, occurrences, and ADS/ADM attendance records hang
off — this is the deepest-referenced id in the mesh. Session ids (`encodeSessionId`) and pod ids
derive downstream of the same catalog, so they move too.

**This alone rules out catalog deletion.** (Reordering has the same effect as deleting, so the
canonical set must be *appended*, never spliced in.)

### 3b. The drift test makes removal deliberate — but does **not** prevent it

`iam-seed-ids/src/ids.test.ts` locks the contract bidirectionally:

```ts
it('has no stale ids beyond the catalog', () => {
  expect(Object.keys(GROUP_IDS_LOCK).sort()).toEqual([...GROUP_SLUGS].sort());
  expect(Object.keys(USER_IDS_LOCK).sort()).toEqual([...USER_SLUGS].sort());
});
```

Adding a slug fails until you add its lock entry (intended). **Removing a slug also fails — until
you delete the lock entry too.** That's a one-line deletion away from green. Plus hard counts that
would need editing:

- `expect(PERSONAS.length).toBe(35)` / 32 group-scoped / 3 templates
- `expect(STUDENTS.length).toBe(221)` · `expect(TUTORS.length).toBe(32)`
- per-persona frozen permission-NAME lists (the byte-target for `authz_persona_definition`)

So the test is a **speed bump, not a guard rail**. Worth knowing before someone "makes the tests
pass."

### 3c. Silent cross-service orphans

Org identity anchors in exactly two columns fleet-wide — rostering `iam_db.groups.org_id` and
program-hub `programs.Program.organizationId`. Everything else reaches the org transitively.
Because cross-service FKs are deliberately dropped and projections are event-materialized, a
removed group id **strands rather than errors** in: the three `*_projection` mirror DBs, coach
`persona_assignment` / `group_track_map`, SDS consumed projections, OpenFGA tuples, qboard `cv3_*`
docs, and S3 artifacts (which never GC).

Projections never self-heal, and Phase-2-style delete *events* cannot clean pre-existing orphans
(no source row ⇒ no delete event). This is the same orphan class `ss env org status --orphans` was
designed to surface.

### 3d. Dev-main and the canonical container

Dev-main's iam store resolves to the db-host-v2 container **`rostering-iam-canonical`** — the same
container `cut-canonical` rebuilds and every sandbox restores from (live-verified 2026-07-21).
So a catalog change plus a canonical re-cut is **not** a preview-only event; it lands on
`dash.wootdev.com`. Worth confirming that coupling with the platform owner before any re-cut,
independent of this proposal.

### 3e. Consumers keyed on the slugs

Modest but non-zero — 6 files outside rostering reference the districts slated for removal:

```
program-hub/packages/core/program-seed-ids/src/catalog.ts        ← the position hazard above
program-hub/apps/node/programs-api/src/prisma/seed.ts
program-hub/apps/node/programs-api/src/__tests__/unit/seed-projections.unit.spec.test.ts
program-hub/apps/node/sessions-api/src/__tests__/unit/seed-canonical.unit.spec.test.ts
soa/packages/core/seed-ids-kit/src/__tests__/seed-ids-kit.unit.test.ts
soa/packages/node/saga-stack-cli/src/core/env/__tests__/env-core.unit.test.ts
```

Plus `ss`'s login defaults (`DEFAULT_LOGIN_USER = 'dev@saga.org'` → the **`seed`** district, which
Adam's set drops) and the `develop session-adm` flows that name catalog emails.

---

## 4. Recommended shape: additive selection, zero deletion

```
catalog.ts        ← APPEND the new canonical district(s). Never delete, never reorder.
                    Old slugs stay; their ids stay valid; nothing orphans.
       │
       ├── seed:district --slug <x>     (new 5th mode — additive, idempotent, layer-ordered)
       │      └─ per-env selection: dev=T1+T2, training=T1+T2+T3, prod=distinct slug
       │
       ├── db:seed (main)               (unchanged — still plants everything, still destructive,
       │                                 still correct for synthetic-dev + container-per-PR)
       │
       └── SEED_DATASET=canonical-small (optional: ss-level identity axis, if we want local
                                         stacks to *match* shared envs instead of superset them)

snapshots: cut `rostering-iam-minimal` alongside `rostering-iam-canonical`.
           Both immutable, both versioned, selectable per composition via seed-profile.
```

**What this gives us:** the small set becomes the default everywhere it matters, the big set stays
available for scale/pagination/edge-case work, no id moves, no orphans, no re-cut risk to dev-main,
and every existing snapshot stays restorable.

**What it costs:** the catalog keeps entries nobody plants by default. That is a documentation
problem, not a correctness one — and §7 of the template doc already solves it by marking tiers.

**If we later genuinely want the old districts gone**, the safe sequence is: (1) ship the small set
additively, (2) prove nothing references the old slugs for a release or two, (3) retire them by
marking them `deprecated: true` in the catalog and excluding them from every profile — *still*
without deleting the entries, because deletion is what moves program ids.

---

## 5. Where the code has an opinion on the open questions

**Q1 — 3 districts or fold Second into Canonical?**
Code leans **3**. `DISTRICT_ADMIN_PERSONA` and `ROSTER_PERSONA_FOR` are per-district maps, so a
second district is nearly free structurally. `multi@saga.org` (member of `seed` + `riverside`) is
the *only* fixture covering the district switcher and cross-district isolation — folding T3 in
deletes that coverage with no replacement. Also `ss env org status/reset` targets **by slug**, so
more slugs = more independently resettable units, which is exactly what the shared-env reset work
wants.

**Q2 — fuse the program/schedule matrix into Canonical, or keep it separate?**
Either is workable, but **however you decide, append**. Two specifics:
- Re-pointing an existing program's `organizationSlug` is **id-safe** (position unchanged) but is a
  *data move* — persisted `organizationId` values would need a migration. Don't do it silently.
- The `varied-*` programs are the only coverage of `VARIES_BY_DAY_TYPE`, archived, and
  holiday-heavy shapes, and the `ab-topology` **SEED_SCENARIO** couples programs+scheduling+sessions
  so they must move together — `composeSeedPlan` throws if that triad is half-applied. Fusing means
  reproducing that triad inside Canonical, not just copying program rows.

**Q3 — generalize `seedRepTrainingOnly` vs the ad-hoc API+CSV path?**
Strongly **yes, generalize**. Four coexisting modes already prove the pattern; `seedRepTrainingOnly`
is already additive, idempotent, layer-ordered, resolves grants by name with a loud failure on
unknown codes, and is *already running against a persistent shared DB in training*. The API+CSV path
is neither idempotent nor byte-identical and can't be re-run to converge.

**Q4 — 200–300 students for the realistic tier?**
For scale context: the *entire* current roster is 253 across 7 districts (`seed` 98, `metro` 54).
A single 200–300-student district ≈ the whole current roster. Cost profile: cheap on auth
(roster people aren't loginable — no `auth_association` row), real on **PII** (per-user encrypt +
HMAC, one round-trip each) and memberships (2 rows/person, both with derived ids). Suggest sizing
from what pagination actually needs to prove rather than a round number — 200 is already ~4× the
largest current district.

**Q5 — prod slug + email domain: confirm now.**
**This is the one decision that must be locked before the first write**, because *every derived id
is a function of the slug*. Changing the slug later changes every group/user/membership UUID —
the same class of break as §3a. Also settle a prior question: prod is SSO-shaped with
`AUTH_ENABLED=true` and `DEV_PERIMETER_ENABLED` force-off, so decide whether password login is
permitted in prod at all before designing accounts that depend on it.

**Q6 — PII / loginable classes.**
Code confirms the split exactly: loginable **iff** in `seed.ts`'s `users` array — the 31 accounts
(10 catalog + 12 demo + 9 `@example.org`). Roster people get PII + memberships + personas but **no
`auth_association` row**. On the argon2 concern (rostering#900): the seed computes **one** hash per
run (`const devPasswordHash = await argon2Hash(...)`) and reuses it across `createMany`, so bulk
cost today is **O(1) in account count, not O(n)** — worth confirming that's what #900 is actually
about before it constrains the realistic tier's size, since it may not bind at all.

---

## 6. Sources

- Seed modes: `/home/skelly/dev/rostering/packages/node/iam-db/prisma/seed.ts` (dispatcher at tail)
- Contract lock: `/home/skelly/dev/rostering/packages/core/iam-seed-ids/src/ids.test.ts`
- **Position-indexed derivation**: `/home/skelly/dev/program-hub/packages/core/program-seed-ids/src/index.ts`
- Breadth knob precedent: `/home/skelly/dev/program-hub/packages/core/program-seed-ids/src/seed-profile.ts`
- Identity/quantity axes: `/home/skelly/dev/soa/packages/node/saga-stack-cli/src/core/seed/datasets.ts`
- Snapshot versioning: `/home/skelly/dev/rostering/.github/workflows/cut-canonical.yml`
- `seed-profile` contract: saga-iac `references/sandbox-seed-profile.md`
- Orphan/anchor analysis: `/home/skelly/dev/shared-env-reset-research.md` §2
