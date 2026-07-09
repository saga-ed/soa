# `iam-small` fixture

A small **rostering-only / iam-only** scenario fixture (rostering#123). It exercises just the
iam-api surface — `iam_local` + `iam_pii_local` — so you can run iam-api end-to-end and use it as a
stable integration-test substrate (rostering#342) without standing up programs-api or ads-adm-api.

## Shape

```
district  iam-small-district
  ├─ school   iam-small-north
  │   ├─ section  iam-small-north-a
  │   └─ section  iam-small-north-b
  └─ school   iam-small-south
      └─ section  iam-small-south-a

users (each with PII): iam-small-admin-1, iam-small-tutor-1, iam-small-tutor-2,
                       iam-small-student-1 … iam-small-student-4
memberships: admin → district; tutors → district + a school;
             students → district + a school + a section
```

All entities tagged `source=demo`, `sourceId=<slug>`.

## Scope — v1 is scoped-down (deliberately)

This fixture is authored with the **existing** `iam:*` verbs only: `iam:create-org`,
`iam:create-user` (+ PII), `iam:add-membership`. It therefore covers **groups + users + memberships
+ PII** and is enough to unblock rostering#342.

It does **not** author **roles, personas, permissions, or policies** — there is no `iam:*`
authoring command for those yet (tracked in **rostering#667**). Concretely, in v1:
- users seed at the default `UserRole` (`USER`) — no per-user role until `iam:create-user --role`;
- memberships carry **no** `personaId` — no persona until `iam:create-persona` / `--persona`.

When #667 lands, this fixture upgrades in place to add admin/tutor/student personas wired to
`STANDARD_BUNDLES` (see `rostering:claude/projects/r_123/02-proposed-iam-fixture.md`).

## Permissions — preserved, not redefined

This fixture **does not define or modify** the permission/policy catalog. That catalog is
source-controlled in `rostering:packages/node/iam-db/src/registry.ts` (`PERMISSIONS[]` / `POLICIES[]`
/ `STANDARD_BUNDLES`) and is unaffected by this fixture. To keep the **snapshot** consistent with the
canonical catalog, author it on a **registry-seeded base** so the dump carries the permissions/
policies and a restore re-installs them:

1. Start from a clean `iam_local` (or `snapshot:restore` an empty base).
2. Seed the standard registry only (no district/persona dev data): run the iam-db registry seed
   (`pnpm -C <rostering>/packages/node/iam-db db:seed:registry`, or `seedRegistry()` directly).
3. Run `./create.sh` to add this fixture's roster entities.
4. `mesh-fixture snapshot:store --fixture-id iam-small`.

The result is a snapshot containing the canonical permission/policy catalog + the iam-small roster,
with **no** personas/assignments (those come with #667). It cannot drift from the source catalog
because it never copies it — it seeds from `registry.ts`.

## Author / snapshot / restore

```bash
# 0. mesh up + registry-seeded base (see §Permissions)
saga-mesh.sh doctor && saga-mesh.sh setup

# 1. author (idempotent; re-runnable)
FIXTURE_ID=iam-small ./create.sh

# 2. snapshot (whole-mesh; the non-iam DBs are simply empty)
mesh-fixture snapshot:store --fixture-id iam-small

# 3. restore (seconds; resets the mesh to this state)
mesh-fixture snapshot:restore --fixture-id iam-small
```

> **Not yet snapshot-verified.** This recipe is authored to the `demo-small` conventions but has not
> been run against a live mesh in this change (no container available). First use should run
> `create.sh` + `snapshot:store` on a mesh and commit/verify the snapshot, the same author step every
> Path-A fixture takes.

## Won't interfere with the personas system

Adding this fixture is purely additive — a new `fixtures/iam-small/` directory. It modifies no shared
code (`registry.ts`, `prisma/seed.ts`, `seed-mode.ts`), no persona/permission tables, and neither
existing fixture. The only way it touches an environment is an explicit `snapshot:restore iam-small`,
which (like any fixture restore) resets the local mesh — opt-in.
