# Saga seed-user structure — the synthetic-dev reference, as a replication template

**Status:** reference spec · **Version:** 1.0 · **Date:** 2026-07-28
**Source of truth (code):** `/home/skelly/dev/rostering/packages/core/iam-seed-ids/src/{catalog,personas,roster,derive}.ts`
and `/home/skelly/dev/rostering/packages/node/iam-db/prisma/seed.ts`
**Companion:** [`01-per-environment-seeding.md`](01-per-environment-seeding.md) (how each environment seeds today)

---

## How to read this document

This describes **exactly what `ss stack seed` produces in synthetic-dev** — the only
environment that currently gets the complete picture — and structures it as a **template**
so the same structure can be replicated into wootdev, training, and eventually prod.

Every value in here is either read directly from the catalog or **derived** from it. Nothing
is hand-assigned. That is the property that makes replication possible: an environment does
not need to be *told* the UUIDs, it **computes** them.

- §1–§2 — the contract and the layer model. Read once.
- §3–§6 — the complete inventory. This is the spec to replicate.
- §7 — **the replication template**: which tier goes to which environment, and why.
- §8 — verification checklist per environment.

> Anything below marked **DERIVED** can be recomputed offline at any time and must never be
> hardcoded in a new consumer. Anything marked **LITERAL** is a frozen id that predates the
> derivation scheme and must be copied verbatim.

---

## 1. The determinism contract

Every canonical id is an RFC-4122 **v5 (SHA-1)** UUID over a fixed namespace:

```
ROOT_NAMESPACE = b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c      # NEVER change — re-randomizes the fleet

deriveGroupId(slug)             = uuidv5("group:"  + slug)
deriveUserId(slug)              = uuidv5("user:"   + slug)
deriveGroupMembershipId(u, g)   = uuidv5("group_membership:" + userId + ":" + groupId)
```

Also stamped on every canonical row: `source = 'canonical'`, `sourceId = <slug>`.
Consumers filter on `source` to tell seeded rows from real ones.

**Two consequences that matter for replication:**

1. **Any environment can compute the whole id-set offline from slugs alone** — no lookup, no
   HTTP, no ordering dependency. A seeder pointed at wootdev produces byte-identical ids to
   one pointed at synthetic-dev.
2. **Membership ids are derived too**, which is what lets a seeded membership and a live
   `iam.group_membership.added` event converge on the same row instead of duplicating. This
   is why an additive seeder is safe to re-run on a persistent environment.

**Verify the derivation in one line** (any language with uuid5):

```python
import uuid; NS = uuid.UUID('b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c')
uuid.uuid5(NS, 'group:emptyOrg')   # -> 52a00136-285b-522c-bc70-0887cf46463a
uuid.uuid5(NS, 'user:dev')         # -> 1e2ca0d8-8f6a-5a97-a141-b38d472a1186
```

---

## 2. The layer model — five layers, replicate in this order

A seed user is never just a user row. It is only *usable* when all five layers exist. Most
"the demo admin exists but sees nothing" bugs are a missing layer, not a missing user.

| # | Layer | Table(s) | Derived from | Skippable? |
|---|---|---|---|---|
| 1 | **Registry** — which permissions/policies exist | `permission`, `policy` | `registry.ts` (LITERAL ids) | ❌ prerequisite for everything |
| 2 | **Groups** — district → school → section | `groups` | `deriveGroupId(slug)` | ❌ |
| 3 | **Personas** — a named role bound to a group, carrying a permission bundle | `persona`, `persona_permission`, `persona_policy` | LITERAL `a003-*` ids | ❌ |
| 4 | **Users + auth + PII** — the identity itself | `users`, `user_profile`, `auth_association`, `user_pii` | `deriveUserId(slug)` | ❌ |
| 5 | **Memberships** — user ↔ group, carrying the persona | `group_membership` | `deriveGroupMembershipId()` | ❌ |

**Order is load-bearing.** Personas resolve their grants **by permission name** against the
registry and fail loud on an unknown code, so layer 1 must precede layer 3. Memberships
reference both a user and a persona, so layer 5 is last.

> ⚠️ **Layer 4 has a silent failure mode.** `auth.login` resolves an account by **email hash
> in the PII store**, not from the `users` table. `seed.ts` **skips PII entirely** unless
> `PII_DEK_HEX`/`PII_HMAC_KEY_HEX` (or the runtime names `PII_CRYPTO_PIIDEKHEX` /
> `PII_CRYPTO_PIIHMACKEYHEX`) are set. Result: the user row exists, the password row exists,
> and login still fails. **This is the single most common seed-user failure — check it first.**

---

## 3. Districts (organizations)

10 districts, each existing to cover one named use case. `orgId` on every group is the
district root; a district is its own org.

| slug | display name | group id (**DERIVED**) | exists to cover |
|---|---|---|---|
| `seed` | Seed District | `71698462-2be8-5eb8-9d7c-443bd59d0c3f` | primary happy path — fully populated |
| `riverside` | Riverside Unified | `0adcbddd-7406-545e-ba75-ef195181145a` | multi-district users, cross-district isolation |
| `metro` | Metro City Schools | `4cedce5b-9173-57c2-8f10-72f8ce4a0509` | scale — many schools/programs, pagination |
| `oakdale` | Oakdale Schools | `b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6` | schools but **no programs** — empty state |
| `frontier` | Frontier District | `ea1562ee-a620-5d5c-82a8-768da7f798c2` | **no schools** — empty hierarchy edge |
| `demo` | Demo District | `a0da8362-1a93-5d1d-aeaa-b6d8960e9821` | **the persona/permission palette** + full session lifecycle states |
| `emptyOrg` | Empty Org | `52a00136-285b-522c-bc70-0887cf46463a` | admin and **nothing else** — first-run, CSV-upload-from-scratch |
| `varied-schedules` | Varied Schedules District | `21e8fb79-1e87-5698-a3bc-628b41d862e1` | schedule shapes + program lifecycle states |
| `minimal-setup` | Minimal Setup District | `0f9721e7-15f1-5561-ab93-2af006b27b40` | one tiny program + a mid-setup draft |
| `rep-training` | Representative Training District | `5122579f-214e-5083-90df-0bb219e5259d` | compact stand-in for a **real** district |

Beneath them: **20 schools**, **44 sections**. `frontier` and `emptyOrg` intentionally have
neither.

---

## 4. Personas — the permission layer

35 personas. Ids are **LITERAL** (`a003-*` group-scoped, `a008-*` templates) — a uuidv5
derivation would not reproduce them and byte-identity with persisted rows is the point.

Permission bundles come from `STANDARD_BUNDLES` in
`/home/skelly/dev/rostering/packages/node/iam-db/src/registry.ts`.

### 4a. Standard trio per district

Most districts get admin (44 perms) / tutor (14) / student (3).

| district | admin persona | tutor | student |
|---|---|---|---|
| `seed` | `…a003-000000000001` personaAdminDistrict | `…002` | `…003` |
| `riverside` | `…011` personaAdminRiverside | `…006` | `…005` (0 perms) |
| `metro` | `…012` personaAdminMetro | `…010` | `…009` (0 perms) |
| `oakdale` | `…013` personaAdminOakdale | `…008` | `…007` (0 perms) |
| `frontier` | `…014` personaAdminFrontier | `…025` | `…024` |
| `emptyOrg` | `…021` personaAdminEmptyOrg | `…023` | `…022` |
| `varied-schedules` | `…026` personaAdminVaried | `…027` | `…028` |
| `minimal-setup` | `…029` personaAdminMinimal | `…030` | `…031` |
| `rep-training` | `…032` personaAdminRepTraining | — | — |

> The `riverside`/`metro`/`oakdale` student personas carry **zero permissions** by design
> (they exist to prove the cascade, not to grant). `frontier` and `emptyOrg` get
> member-less STUDENT/TUTOR personas so a from-scratch CSV upload can resolve those roles —
> sis-api derives a district's acceptable `canonical_role` values from the personas on its
> group, so an admin-only district would reject every non-admin row.

### 4b. The Demo District palette — the permission-boundary set

This is the one that matters most for replication: it is the only place the *shape* of the
permission model is exercised rather than just the happy path.

| persona id (**LITERAL**) | key | group | role | perms | what it proves |
|---|---|---|---|---|---|
| `00000000-0000-4000-a003-000000000015` | personaAdminDemo | `demo` (district) | ADMIN | 44 | full district admin |
| `…016` | personaAdminDemoLimited | `demo` (district) | ADMIN | **9** | **limited/observer admin** — view + observe only |
| `…017` | personaAdminDemoNorth | `demo-north` (school) | ADMIN | 44 | **school-scoped** admin |
| `…018` | personaLeadTutorDemoNorth | `demo-north` (school) | TUTOR | 18 | **lead tutor** — tutor + observe/non-member |
| `…019` | personaTutorDemo | `demo` (district) | TUTOR | 14 | standard tutor, host-only |
| `…020` | personaStudentDemo | `demo` (district) | STUDENT | 3 | standard student |

### 4c. Templates (group-detached, never assigned)

| id | key | role | perms |
|---|---|---|---|
| `00000000-0000-4000-a008-000000000001` | templateAdmin ("Standard Admin") | ADMIN | 44 |
| `…a008-000000000002` | templateTutor | TUTOR | 14 |
| `…a008-000000000003` | templateStudent | STUDENT | 3 |

`groupId = null`, `isTemplate = true` — dashboard-only starting points for cloning.

---

## 5. The user inventory

**Shared password for every loginable seed account: `password123`** (argon2id, one hash
reused; mirrors iam-api's `ARGON2_PARAMS` so the normal `auth.login` flow works without a
reset). Declared once at `seed.ts` `DEV_PASSWORD`.

### 5a. Tier A — catalog users (10) · one admin per district

**DERIVED** ids. Source: `catalog.ts` `USERS`. Each is bound to its district's admin persona
via `DISTRICT_ADMIN_PERSONA`.

| slug | email | display name | district(s) | user id (**DERIVED**) | role |
|---|---|---|---|---|---|
| `dev` | `dev@saga.org` | Dev User | seed | `1e2ca0d8-8f6a-5a97-a141-b38d472a1186` | ADMIN |
| `multi` | `multi@saga.org` | Multi District | seed, riverside | `9fcc8ff8-85f9-54d2-98da-4ce20a222f2c` | ADMIN |
| `many` | `many@saga.org` | Many Programs | metro | `cfca392e-196c-5f38-8c02-16b73aa35881` | ADMIN |
| `new` | `new@saga.org` | New District | oakdale | `9888c0f7-ef24-5e31-a211-7e7ece92019d` | ADMIN |
| `frontier` | `frontier@saga.org` | Frontier User | frontier | `403f2a05-363a-53c8-9da8-eaf26aba921a` | ADMIN |
| `empty` | `empty@saga.org` | Empty Org Admin | emptyOrg | `506605c6-f2c5-5785-9837-7970e7a2594c` | ADMIN |
| `none` | `none@saga.org` | No District | **(none)** | `08727c23-d556-5aa7-9ecf-57b69cd04f72` | USER |
| `varied-schedules` | `varied-schedules@saga.org` | Varied Schedules Admin | varied-schedules | `58efb97f-2b15-58a5-ad52-3762a9d3a8e6` | ADMIN |
| `minimal-setup` | `minimal-setup@saga.org` | Minimal Setup Admin | minimal-setup | `1deb2ccd-9941-5ab6-bc76-d756ccaa6975` | ADMIN |
| `rep-training` | `rep-training@saga.org` | Representative Training Admin | rep-training | `9e1ab55e-f898-56e5-9236-fc8b21120cfc` | ADMIN |

`role` is derived, not declared: `districtSlugs.length > 0 ? ADMIN : USER`.
The district-count spread (0 / 1 / 2) is deliberate — it covers the "no org", "one org",
"org switcher" UI cases.

### 5b. Tier B — Demo District palette (12) · the role-shape set

**DERIVED** ids. These are the accounts that exercise the permission model.

| slug / username | email | name | user id (**DERIVED**) | memberships (group → persona) |
|---|---|---|---|---|
| `demo-dadmin` | `demo-dadmin@saga.org` | Dana Adams | `0ebae718-172d-5ba2-9899-a90b47e183b6` | demo → **personaAdminDemo** |
| `demo-dadmin-ro` | `demo-dadmin-ro@saga.org` | Omar Reed | `1c1b642c-e5e3-5c0f-b23e-5eedb458f8bc` | demo → **personaAdminDemoLimited** |
| `demo-admin-north` | `demo-admin-north@saga.org` | Nina Cole | `8e90a813-6257-53e8-9a2b-2ac86a18891b` | demo → (none); demo-north → **personaAdminDemoNorth** |
| `demo-lead-north` | `demo-lead-north@saga.org` | Leo Park | `8f36333d-c5ec-5b51-85fe-90e1f3ca5e1c` | demo → personaTutorDemo; demo-north → **personaLeadTutorDemoNorth**; sec-dn-1 |
| `demo-tutor-1` | `demo-tutor-1@saga.org` | Tess Ng | `1c939568-1464-5f9a-b5a4-0bc73a0454cb` | demo → personaTutorDemo; demo-north; sec-dn-2 |
| `demo-tutor-2` | `demo-tutor-2@saga.org` | Raj Patel | `033c9598-535b-5fd4-b722-19c32585410c` | demo → personaTutorDemo; demo-south; sec-ds-1 |
| `demo-student-1` | `demo-student-1@saga.org` | Ava Lin | `3c308510-84e5-5e2f-80c0-39fa352f1d3b` | demo → personaStudentDemo; demo-north; sec-dn-1 |
| `demo-student-2` | `demo-student-2@saga.org` | Ben Ortiz | `53a6f726-5e11-50c8-a933-b04bc8e837a0` | demo → personaStudentDemo; demo-north; sec-dn-1 |
| `demo-student-3` | `demo-student-3@saga.org` | Cleo Diaz | `a3f552e8-bbf0-5bec-a833-cd4168b77b30` | demo → personaStudentDemo; demo-north; sec-dn-2 |
| `demo-student-4` | `demo-student-4@saga.org` | Dev Khan | `79496fc7-51a1-57b1-87b9-ce37b6a215f8` | demo → personaStudentDemo; demo-north; sec-dn-2 |
| `demo-student-5` | `demo-student-5@saga.org` | Eli Wong | `f0c0229e-2e1b-51dc-a03b-c6433c9dc1b5` | demo → personaStudentDemo; demo-south; sec-ds-1 |
| `demo-student-6` | `demo-student-6@saga.org` | Faye Roy | `cad94eaa-4947-54ef-81f6-c8c9cd9fa078` | demo → personaStudentDemo; demo-south; sec-ds-1 |

Demo groups (**DERIVED**): `demo-north` `de07ab6c-b794-5310-8697-a706d7eb648a` ·
`demo-south` `b31ea54c-c955-5632-8890-66555d8e026c` ·
`sec-dn-1` `4e7588a6-082f-508d-b7b5-00dc5d48ea16` · `sec-dn-2` `359356af-022f-5a60-9bb5-2b87d8c06f74` ·
`sec-ds-1` `4f4b0131-ab38-5de4-a015-f95dafbcb02a` · `sec-ds-2` `a8a9ffc9-3ae7-5b3d-90b5-d294f35edccf`

Membership map is declared once in `personas.ts` `DEMO_MEMBERSHIPS`, so the full seed and
the additive `seed:demo` path cannot diverge.

### 5c. Tier C — named `@example.org` fixtures (9) · **LITERAL** ids, all in `seed` district

Pre-catalog fixtures kept for byte-identity with persisted data and friendly names in demos.

| id (**LITERAL**) | username | email | name | role | persona |
|---|---|---|---|---|---|
| `f0000004-0000-4000-8000-000000000001` | `jordanm` | `jordan@example.org` | Jordan Mitchell | ADMIN | personaAdminDistrict @ seed |
| `…000000000002` | `samanthak` | `samantha@example.org` | Samantha Kim | ADMIN | personaAdminDistrict @ seed + **personaAdminLincoln @ lincoln** (school override) |
| `…000000000003` | `alexr` | `alex@example.org` | Alex Rivera | TUTOR | personaTutorDistrict @ seed → lincoln → sec-101 |
| `…000000000004` | `mariag` | `maria@example.org` | Maria Garcia | TUTOR | personaTutorDistrict @ seed → washington → algebra |
| `…000000000005` | `emmaj` | `emma@example.org` | Emma Johnson | STUDENT | personaStudentDistrict @ seed |
| `…000000000006` | `liamw` | `liam@example.org` | Liam Williams | STUDENT | personaStudentDistrict @ seed |
| `…000000000007` | `olivias` | `olivia@example.org` | Olivia Smith | STUDENT | personaStudentDistrict @ seed |
| `…000000000008` | `noahb` | `noah@example.org` | Noah Brown | STUDENT | personaStudentDistrict @ seed |
| `…000000000009` | `devuser` | `dev@example.org` | Dev User | ADMIN | admin persona @ **`demo`** district (via `seed:dev-user`) |

> ⚠️ **Two "dev" identities exist and they are different users.**
> `dev@saga.org` (`1e2ca0d8…`, catalog, **seed** district) vs `dev@example.org`
> (`f0000004-…-009`, username `devuser`, **demo** district). The second is what
> `seed:dev-user` mints and is the *only* identity wootdev/training CI creates today. Be
> explicit about which one a runbook means.

### 5d. Tier D — roster people (253) · **NOT loginable**

Materialized from `roster.ts` `ROSTER`, ids via `personId('s-7')` /`personId('t-3')` — a pure
string scheme (`00000000-0000-4000-a000-…` students, `…-b000-…` tutors), browser-safe.

| district | people | students | tutors |
|---|---|---|---|
| `seed` | 98 | 89 | 9 |
| `metro` | 54 | 48 | 6 |
| `rep-training` | 35 | 31 | 4 |
| `varied-schedules` | 25 | 20 | 5 |
| `riverside` | 22 | 18 | 4 |
| `oakdale` | 16 | 13 | 3 |
| `minimal-setup` | 3 | 2 | 1 |
| **total** | **253** | **221** | **32** |

`demo`, `frontier`, `emptyOrg` have zero roster people by design.

> ⚠️ **Roster people have PII + memberships + personas but NO `auth_association` row — they
> cannot log in.** Do not hand someone an `s-###`/`t-##` person as a "student login". Use
> Tier B or Tier C.

### 5e. Totals

| tier | count | loginable | ids |
|---|---|---|---|
| A — catalog users | 10 | ✅ | DERIVED |
| B — demo palette | 12 | ✅ | DERIVED |
| C — `@example.org` fixtures | 9 | ✅ | LITERAL |
| D — roster people | 253 | ❌ | LITERAL scheme |
| **loginable total** | **31** | | |

---

## 6. Login mechanics — differs by environment, plan for it

| | synthetic-dev | wootdev / training / prod |
|---|---|---|
| `auth.devLogin` (email, no password) | ✅ works — `ss stack login <email>` uses it | ❌ **FORBIDDEN** — `AUTH_ENABLED=true` on every deployed env; returns 403 |
| `auth.login` (email + `password123`) | ✅ | ✅ (wootdev/training) — **requires the PII row** |
| Perimeter | none | janus `gate.wootdev.com`; **no gate** on the training apex; prod is inner-session-only |

**Implication for replication:** a replicated seed user is only useful on a deployed
environment if layer 4 wrote the **PII row**. On synthetic-dev you can get away without it
(devLogin accepts a raw UUID identifier); everywhere else you cannot.

---

## 7. The replication template

The full synthetic-dev set (31 logins + 253 roster people + 10 districts) is **correct for a
throwaway stack and wrong for a shared persistent one**. Replicate in tiers, and pick the
tier per environment.

### 7a. Tier definitions

| Tier | Contents | Rows (approx) | Purpose |
|---|---|---|---|
| **T0 — Registry** | permissions + policies only | 64 permissions + policies | prerequisite; already runs everywhere incl. prod |
| **T1 — Core demo set** | `demo` district + 2 schools + 4 sections + 6 personas + the 12 Tier-B users | ~35 | **the recommended shared-env set** — exercises every role shape in one org |
| **T2 — Empty org** | `emptyOrg` district + 3 personas + `empty@saga.org` | ~6 | first-run / CSV-upload-from-scratch; already the `ss env org reset` target |
| **T3 — Representative district** | `rep-training` + 2 schools + 5 sections + admin + 35 roster people | ~45 | realistic-district review; **already shipping to training** |
| **T4 — Full catalog** | all 10 districts, 253 roster people, all 31 logins | ~350 | synthetic-dev + PR previews only |

### 7b. Tier per environment

| Environment | Tiers | Vehicle | Destructive seed allowed? |
|---|---|---|---|
| **synthetic-dev** | T0–T4 | `ss stack seed roster\|full` (runs `db:seed`) | ✅ always |
| **PR preview / sandbox** | T0–T4 | container-per-PR `db:seed`, or restore `seed-profile: canonical` | ✅ isolated DB |
| **wootdev (dev main)** | T0 + **T1** + T2 | append additive seed to `deploy-iam-api.yml` dev branch | ❌ never |
| **training** | T0 + **T1** + T2 + **T3** | append to `deploy-iam-api-training.yml`'s existing chain (T3 already there as `seed:rep-training`) | ❌ never |
| **prod** | T0 only today | separate approval-gated `workflow_dispatch`, **not** the deploy path | ❌ never |

**Why T1 is the recommended shared-env set:** it is one self-contained org that covers full
admin, limited/observer admin, school-scoped admin, lead tutor, tutor, and student — six
distinct permission shapes — in ~35 rows, with zero roster bloat. Everything else is either
a scale fixture (T4) or a single-purpose edge case (T2/T3).

### 7c. Non-negotiable rules for any replicated seeder

1. **Additive and idempotent.** Upsert by derived id. The only permitted deletes are scoped
   to the seeder's own ids (the pattern `seedRepTrainingOnly` already proves: scoped
   delete-and-recreate of *its* persona→permission rows, nothing else).
2. **Never `db:seed` on a persistent environment.** It `deleteMany()`s every iam table and
   `DELETE`s from `user_pii`.
3. **Target by catalog slug, never a raw UUID.** This is the structural guard that keeps
   hand-built orgs (Jenny's training districts) untargetable by a typo. Same rule
   `ss env org reset` enforces.
4. **Resolve persona grants by permission NAME against the registry and fail loud** on an
   unknown code. Silently skipping unknown codes is how `seed:org` ships permissionless
   admins.
5. **Assert PII crypto env is present before writing users**, or fail with an explicit
   message. Silently skipping PII produces accounts that exist and cannot log in.
6. **Run in layer order** (§2): registry → groups → personas → users/auth/PII → memberships.
7. **Prod gets a distinct district slug and a distinct email domain**, so a prod demo account
   can never be mistaken for a real one. Do not reuse `@saga.org` there.

### 7d. What to build

The primitive already exists and is proven on a persistent environment:
**`seedRepTrainingOnly`** in `/home/skelly/dev/rostering/packages/node/iam-db/prisma/seed.ts`.
It takes one district slug and additively upserts groups + persona + grants + users + PII +
memberships, with every delete scoped to that district's derived ids.

Generalize it to `seed:district --slug <catalogSlug>` (env `SEED_DISTRICT_ONLY=<slug>`),
driven entirely off the catalog slices it already computes — `DISTRICTS.filter`,
`SCHOOLS.filter`, `SECTIONS.filter`, `ROSTER.filter`, `USERS.filter(u =>
u.districtSlugs.includes(slug))`, `DISTRICT_ADMIN_PERSONA[slug]`, `ROSTER_PERSONA_FOR[slug]`,
and `DEMO_MEMBERSHIPS` for the demo tier. Keep `seed:rep-training` and `seed:demo` as thin
aliases so existing workflows don't churn.

That one script, invoked with different slugs, satisfies every row of the §7b table.

---

## 8. Verification checklist

Run per environment after seeding. All of these are read-only.

**Structural**
- [ ] `SELECT count(*) FROM groups WHERE source = 'canonical'` matches the expected tier
- [ ] Every expected district id resolves — recompute with `uuidv5('group:'+slug)` and match
- [ ] `SELECT count(*) FROM persona WHERE group_id = <district id>` matches the tier's persona count
- [ ] No persona has zero permissions where the bundle says otherwise (catches a registry/name mismatch)

**Identity**
- [ ] Each expected user id resolves — recompute with `uuidv5('user:'+slug)` and match
- [ ] Each loginable user has an `auth_association` row with `provider_type='PASSWORD'`, `active=true`
- [ ] **Each loginable user has a `user_pii` row** ← the one people miss
- [ ] Each district admin's membership carries a non-null `persona_id`

**Functional (the real gate)**
- [ ] `auth.login` with the email + `password123` returns a session (not devLogin — that's 403 on deployed envs)
- [ ] The admin lands on a non-empty dashboard: sessions/rosters tabs visible, programs listed
- [ ] The limited admin (`demo-dadmin-ro`) sees **fewer** surfaces than `demo-dadmin` — this is the
      check that proves personas are wired, not just present
- [ ] A tutor sees only their own sessions; a student sees the reduced detail view

**Convergence (deployed envs only)**
- [ ] `ss env org status --env <env> --org <slug> --url iam=…` shows the expected per-table counts
- [ ] Re-run the seeder — counts are unchanged (idempotency proof)

---

## Appendix — quick reference card

```
Password (all seed logins, dev/training only):  password123

Best walkthrough admin (rich data):             many@saga.org        (metro)
Best permission-model demo:                     demo-dadmin@saga.org (demo)
Limited/observer admin (compare against above): demo-dadmin-ro@saga.org
School-scoped admin:                            demo-admin-north@saga.org
Lead tutor / tutor / student:                   demo-lead-north@ / demo-tutor-1@ / demo-student-1@
First-run / empty org:                          empty@saga.org       (emptyOrg)
Realistic district:                             rep-training@saga.org
No-org user (nav edge case):                    none@saga.org
CI-created identity on wootdev + training:      dev@example.org      (demo district)

Cannot log in:  every s-###/t-## roster person (no auth_association row)
```

**Canonical, can't-go-stale account list:** run `pnpm db:seed` in
`/home/skelly/dev/rostering/packages/node/iam-db` — the tail prints every user and the
password. Documented at
`/home/skelly/dev/rostering/packages/node/iam-db/prisma/README.md`.
