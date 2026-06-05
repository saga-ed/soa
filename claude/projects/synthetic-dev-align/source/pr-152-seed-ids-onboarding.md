<!-- Snapshot of saga-dash PR #152 :: docs/seed-ids-onboarding.md
     Source: saga-ed/saga-dash @ branch docs/seed-ids-onboarding
     Captured 2026-06-04. Trust the live PR if this diverges. -->

# Canonical Seed-IDs — Developer Onboarding & Inventory

> **Status:** all three seed-ids packages are published to CodeArtifact at **`0.1.0-dev.0`**
> and ready to consume. See [§2](#2-the-three-packages) for the package list and
> [§4a](#4a-install-from-codeartifact) to install.
>
> **Want to run the whole mesh locally?** See the companion
> [Local Mesh Runbook](./seed-ids-local-mesh-runbook.md) — bring up several services on your
> laptop and watch them correlate through these ids.

---

## 1. What these are & why they exist

`@saga-ed/*-seed-ids` are tiny, **dev-only** packages that hand every service the **same
UUIDs** for shared seed data — districts, schools, users, programs, content — **by
construction**, with no shared database, no HTTP call, and no ordering dependency.

Before them, three disconnected ID worlds existed (from `iam-seed-ids/README.md`):

| Where | Example | Problem |
|---|---|---|
| iam-api `db:seed` | `f0000002-…`, `source=manual` | consumed by nobody cross-service |
| rostering scenario | random UUIDs, `source=scenario` | re-randomized each run; needs live iam-api |
| program-hub seed | `seed-org-001` strings | only resolves via an HTTP call after a scenario |

The fix: every canonical UUID is `uuidv5("<kind>:<slug>", ROOT_NAMESPACE)` (or a fixed
literal scheme). Two services that import the package compute the **same id for the same
slug**. Restore each service DB from its **named canonical snapshot**, and the mesh lines
up at startup. **Events remain the runtime propagation path; seed-ids are the seed-time
agreement.**

---

## 2. The three packages

| Package | Repo · path | Role | Version |
|---|---|---|---|
| `@saga-ed/iam-seed-ids` | `rostering/packages/core/iam-seed-ids` | **Foundational** — districts/schools/sections/users/roster | `0.1.0-dev.0` |
| `@saga-ed/program-seed-ids` | `program-hub/packages/core/program-seed-ids` | Programs / periods / sessions / slots (depends on iam) | `0.1.0-dev.0` |
| `@saga-ed/content-seed-ids` | `program-hub/packages/core/content-seed-ids` | Content items (lessons/practice/assessments) | `0.1.0-dev.0` |

**Dependency direction:** `program-seed-ids` → depends on `@saga-ed/iam-seed-ids@0.1.0-dev.0`
(for `groupId`/org resolution). `content-seed-ids` is standalone. iam-seed-ids depends on
nothing.

**Two import worlds (important):**
- **Browser-safe** (`saga-dash`, `janus`): import the package root — frozen literal UUIDs,
  zero `node:crypto`. e.g. `import { groupId, userId } from '@saga-ed/iam-seed-ids'`.
- **Node-only** (`*-api` seeds, codegen): import the `/derive` subpath for the live
  `uuidv5` derivation. e.g. `import { deriveGroupId } from '@saga-ed/iam-seed-ids/derive'`.
  (program-/content-seed-ids expose only `.` — their literals are computed at module load.)

---

## 3. ID inventory (what has been created)

Each package's `catalog.ts` / `ids.ts` are the source of truth for the IDs below.

### 3a. `@saga-ed/iam-seed-ids`
*Source of truth:* `src/catalog.ts` (data) · `src/ids.ts` (frozen UUIDs) · `src/roster.ts` ·
`src/derive.ts` (derivation).

- **`ROOT_NAMESPACE = b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c`** — the contract. Changing it
  re-randomizes every id and breaks every consumer. **NEVER change it.**
- **`CANONICAL_SOURCE = 'canonical'`** — the `source` tag iam-api writes on every canonical
  group; consumers filter on it.

**Derivation schemes**
- Districts / schools / sections (any "group"): `deriveGroupId(slug) = uuidv5("group:"+slug)`
- Users: `deriveUserId(slug) = uuidv5("user:"+slug)`
- Roster persons: pure string (browser-safe, no crypto):
  `personId("s-7") = 00000000-0000-4000-a000-000000000007` (student, variant `a`);
  `personId("t-3") = 00000000-0000-4000-b000-000000000003` (tutor, variant `b`).

**5 districts** (each tagged with the use-case it covers):

| slug | UUID | use case |
|---|---|---|
| `seed` | `71698462-2be8-5eb8-9d7c-443bd59d0c3f` | primary happy-path, fully populated |
| `riverside` | `0adcbddd-7406-545e-ba75-ef195181145a` | multi-district users / cross-district isolation |
| `metro` | `4cedce5b-9173-57c2-8f10-72f8ce4a0509` | large district (many schools/programs) |
| `oakdale` | `b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6` | district with NO programs (empty-state) |
| `frontier` | `ea1562ee-a620-5d5c-82a8-768da7f798c2` | district with NO schools (edge case) |

**13 schools** — `seed`: lincoln, washington, jefferson · `riverside`: mapleGrove, cedarPark ·
`oakdale`: oakdaleElem, oakdaleMiddle · `metro`: metroEast, metroWest, metroCentral,
metroNorth, metroSouth, metroLakeside.

**28 sections** — `sec-101 … sec-NNN` (course offerings under schools).

**6 users** (all `@saga.org`, password **`password123`**, argon2id):

| slug | email | districts |
|---|---|---|
| `dev` (`1e2ca0d8-8f6a-5a97-a141-b38d472a1186`) | dev@saga.org | seed |
| `multi` | multi@saga.org | seed, riverside |
| `many` | many@saga.org | metro |
| `new` | new@saga.org | oakdale |
| `frontier` | frontier@saga.org | frontier |
| `none` | none@saga.org | (no district) |

> Best happy-path walkthrough user: **`many@saga.org`** (metro, many programs) or
> **`dev@saga.org`** (seed district).

**190 roster** — 168 students (`s-1 … s-168`) + 22 tutors (`t-1 … t-22`), each with a
name + section assignment. Mirrors `@saga-ed/rostering-client`'s `seed-data.ts` byte-for-byte.

### 3b. `@saga-ed/program-seed-ids`
*Source of truth:* `src/catalog.ts` · `src/session-id.ts`. **Namespaces:** programs
`a1b2c3d4-0001-4000-8000-*`, periods `a1b2c3d4-0002-4000-8000-*`.

**9 programs** (each linked to an iam district + schools):

| slug | org (district) |
|---|---|
| `lincoln-fall` (`…000000000001`) | seed (schools: lincoln, washington) |
| `roosevelt-ab` | seed (jefferson) |
| `riverside-afterschool` | riverside (mapleGrove) |
| `metro-east` / `metro-west` / `metro-central` / `metro-north` / `metro-south` / `metro-lakeside` | metro |

Plus deterministic **periods** (`periodId(programSlug, periodKey)`), **sessions**
(`sessionId(parts)` + `encodeSessionId`/`decodeSessionId` codecs), and **slots**
(`slotId(periodId, rotationIndex)`).

**API:** `getProgram`, `programId`, `periodId`, `programOrgId` (returns the iam `groupId`),
`periodKeys`, `sessionId`, `slotId`.

### 3c. `@saga-ed/content-seed-ids`
*Source of truth:* `src/catalog.ts`. **Namespace:** `c0a1b2c3-0001-4000-8000-*` (distinct
from programs to avoid collisions).

**12 content items** (`contentId(slug) = CONTENT_NS + index`):
`c-warm-001` (`…000000000001`), `c-poll-014`, `c-ada-201`, `c-exit-088`, `c-geo-301`,
`c-geo-310`, `c-geo-422`, `c-geo-555`, `c-ms-101`, `c-rt-440`, `c-ms-330`, `c-ms-340` —
mix of practice/assessment/lesson across Algebra I, Geometry, Pre-Algebra (two Spanish).

**API:** `getContent`, `contentId`.

---

## 4. Using seed-ids (developer guide)

### 4a. Install from CodeArtifact
These are published to the `saga_js` CodeArtifact repo
(`saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/`). To install in a
worktree:

```bash
aws codeartifact get-authorization-token --domain saga --domain-owner 531314149529 \
  --profile saga-deploy-prod --query authorizationToken --output text   # write into .npmrc
pnpm install
```

Pin the **published dev version** when consuming **across repos**:
```jsonc
// package.json
"@saga-ed/iam-seed-ids":     "0.1.0-dev.0",
"@saga-ed/program-seed-ids": "0.1.0-dev.0"
```
Within the **same repo**, use `workspace:*` (e.g. program-hub's `programs-api` →
`program-seed-ids`). **Never** use a `link:../../rostering/...` path across repos — it breaks
CI (see [§6 Conventions](#6-conventions--rules)).

### 4b. Producer pattern — iam-api `db:seed` (Node, derive)
`rostering/packages/node/iam-db/prisma/seed.ts` materializes the whole catalog:
```ts
import { DISTRICTS, SCHOOLS, USERS, CANONICAL_SOURCE } from '@saga-ed/iam-seed-ids';
import { deriveGroupId } from '@saga-ed/iam-seed-ids/derive';

for (const d of DISTRICTS) {
  await prisma.group.upsert({
    where:  { id: deriveGroupId(d.slug) },
    create: { id: deriveGroupId(d.slug), kind: 'district',
              displayName: d.displayName, source: CANONICAL_SOURCE, sourceId: d.slug },
    update: {},
  });
}
```

### 4c. Consumer pattern — another service's seed (no live iam-api)
`program-hub/apps/node/programs-api/src/prisma/seed.ts`:
```ts
import { groupId } from '@saga-ed/iam-seed-ids';
import { programId, programOrgId } from '@saga-ed/program-seed-ids';

await prisma.program.create({
  data: { id: programId('lincoln-fall'), organizationId: programOrgId('lincoln-fall') },
  //                                       ^ === groupId('seed') === the iam-seeded district
});
```
`programOrgId('lincoln-fall')` equals the UUID iam already seeded, so the row correlates at
DB startup — no scenario run, no HTTP resolve.

### 4d. Browser pattern — saga-dash / janus (frozen literals)
```ts
import { groupId, userId, getDistrict } from '@saga-ed/iam-seed-ids';
const DISTRICT = groupId('seed');     // x-organization-id header
const DEV_USER = userId('dev');       // x-user-id — stable across reseeds
getDistrict('oakdale').useCase;       // deliberately pick the empty-state district
```

### 4e. Adding / changing a canonical entity
1. Edit the package's `catalog.ts` (add the district/program/content row).
2. `pnpm gen` to regenerate `ids.ts` (frozen literals).
3. `pnpm test` — the **drift test** (`ids.test.ts`) fails until the literal matches the
   derivation; commit the regenerated `ids.ts`.
4. Re-seed / re-snapshot affected services (the new id flows to every consumer for free).

---

## 5. Seed-profiles, snapshots & the db-host-v2 plumbing

seed-ids make IDs agree; **canonical snapshots** make the data exist. PR previews and the
local mesh restore each service DB from a named snapshot at provision time.

- **Orchestrator API:** `iac/cloudformation_templates/dbs/db_host_v2/orchestrator/API.md`
  (Lambda `dev-db-host-orchestrator`). Actions: `provision` (optional `seedProfile`+`seedFrom`),
  `switch`/`restore`, `snapshot`, `reset`, `profiles`, `list`/`describe`, `health`.
- **CI threading:** `provision-preview-db-secret` action + `_deploy-ecs-api.yml` +
  `sandbox-deploy.yml` forward `seed-profile` / `seed-from` into the `provision` payload;
  when both are set the orchestrator restores the S3 snapshot into the fresh per-PR container.
- **Canonical snapshots** (`s3://saga-db-seeds-dev/<db>/profile-canonical.sql`):
  `rostering-iam-canonical`, `rostering-iam-pii-canonical`, `program-hub-programs-canonical`,
  `program-hub-scheduling-canonical`, `content-api-postgres`.
- **Container-per-PR:** each preview deploy provisions a dedicated Postgres container
  (iam-api provisions **two**: `iam_db` + `iam_pii_db`). `provision` is **create-once**; the
  action guards re-provision via a triage→describe→derive idempotency path.

---

## 6. Conventions & rules

- **Dev-only forever.** seed-ids ship **only** as `0.1.0-dev.0` prereleases — never a stable
  release. They are test/dev seed fixtures, not production data.
- **`ROOT_NAMESPACE` is frozen** (`b2c4f1a0-…`). Changing it invalidates every id everywhere.
- **Cross-repo deps pin the published version** (`0.1.0-dev.0`); same-repo deps use
  `workspace:*`. No `link:` paths across repos (breaks CI).
- **Browser code imports the root**, never `/derive` (keeps `node:crypto` out of bundles).
- **The catalog is the contract** — add an entity in `catalog.ts`, regenerate, let the drift
  test enforce it. Don't hand-write UUIDs.

---

## 7. Reference

| Thing | Path |
|---|---|
| iam-seed-ids package + README | `rostering/packages/core/iam-seed-ids/` |
| program-seed-ids package | `program-hub/packages/core/program-seed-ids/` |
| content-seed-ids package | `program-hub/packages/core/content-seed-ids/` |
| Producer seed | `rostering/packages/node/iam-db/prisma/seed.ts` |
| Consumer seeds | `program-hub/apps/node/{programs,scheduling,content}-api/src/prisma/seed.ts` |
| Orchestrator API | `iac/cloudformation_templates/dbs/db_host_v2/orchestrator/API.md` |
| CI seed-profile threading | `{rostering,program-hub}/.github/actions/provision-preview-db-secret/action.yml` |
| CodeArtifact | domain `saga`, owner `531314149529`, repo `saga_js`, region `us-west-2` |

**Canonical login:** any `{dev,multi,many,new,frontier,none}@saga.org` / `password123`.
