# Demo data across the four environments — what's supported, and how to get one consistent set of demo users

_Research 2026-07-28. Sources read: `rostering` (iam-seed-ids catalog, iam-db seeds, all deploy/preview/sandbox workflows), `program-hub` (4 services × dev/training/preview), `student-data-system`, `coach`, `soa/packages/node/saga-stack-cli` (seed + `ss env`), saga-iac references (`training-apex.md`, `seed-fixtures.md`, `sandbox-seed-profile.md`), and the prior research docs `~/dev/shared-env-reset-research.md` + `~/dev/whats-left-to-repro-in-training.md`. Scope: the mesh, not legacy `saga_api`._

---

## 0. The one-paragraph answer

There **is** already a single, fleet-wide contract for "who the demo users are": the
`@saga-ed/iam-seed-ids` **catalog** (`/home/skelly/dev/rostering/packages/core/iam-seed-ids/src/catalog.ts`),
whose `USERS`/`DISTRICTS` arrays are turned into deterministic UUIDs by `uuidv5(<kind>:<slug>)`
under a frozen `ROOT_NAMESPACE`. Any service, in any environment, can compute the same id
from the same slug with no DB and no HTTP. **What is NOT consistent is which *seeder* each
environment runs against that catalog.** Local synthetic-dev runs the full destructive
`db:seed` and gets 100% of it; PR-previews/sandboxes restore a `canonical` snapshot of the
same thing; wootdev-main and training only run *additive slices* (`seed:registry`,
`seed:dev-user`, `seed:rep-training`) because a persistent shared DB must never be
truncated; prod runs `seed:registry` only and deliberately has **no demo identities at
all**. So the fix is not a new catalog — it's an **additive, org-scoped seeder** that can
safely materialize a chosen catalog slice into a persistent environment, which is exactly
the shape `seed:rep-training` already proves and `ss env org reset` (soa#355) already
half-implements.

---

## 1. The shared contract (this part already works everywhere)

| Package | Repo path | Derivation |
|---|---|---|
| `@saga-ed/iam-seed-ids` | `/home/skelly/dev/rostering/packages/core/iam-seed-ids` | `uuidv5("<kind>:<slug>", ROOT_NAMESPACE)` — `deriveGroupId`, `deriveUserId` |
| `@saga-ed/program-seed-ids` | `/home/skelly/dev/program-hub/packages/core/program-seed-ids` | position-suffix `PROGRAM_NS + pad(i+1)`; **depends on** iam-seed-ids |
| `@saga-ed/content-seed-ids` | `/home/skelly/dev/program-hub/packages/core/content-seed-ids` | position-suffix under `CONTENT_NS` |
| `@saga-ed/seed-ids-kit` | `soa/packages/core` | the shared mechanism for the next domain |

`ROOT_NAMESPACE = b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c`, `CANONICAL_SOURCE = 'canonical'`.
**Never change either** — it re-randomizes every id fleet-wide.

### The catalog today — 10 districts, 10 catalog users

`DISTRICTS`: `seed`, `riverside`, `metro`, `oakdale`, `frontier`, `demo`, `emptyOrg`,
`varied-schedules`, `minimal-setup`, `rep-training` — each carrying a `useCase` string
saying what it exists to exercise. Plus 20 schools, 44 sections, and a 253-person `ROSTER`
(221 students `s-###` + 32 tutors `t-##`).

`USERS` (all `@saga.org`, all password `password123`, argon2id):
`dev`, `multi`, `many`, `new`, `frontier`, `empty`, `none`, `varied-schedules`,
`minimal-setup`, `rep-training`.

Beyond the catalog, `prisma/seed.ts` adds two more login groups:
- **Demo District palette** — `demo-dadmin`, `demo-dadmin-ro`, `demo-admin-north`,
  `demo-lead-north`, `demo-tutor-1/2`, `demo-student-1..6` (12 accounts, `@saga.org`).
- **Named `@example.org` fixtures** — a couple of TUTORs and a handful of STUDENTs.
- Plus `dev@example.org` (`devuser`, id `f0000004-0000-4000-8000-000000000009`) from the
  standalone `seed-dev-user.ts`.

> ⚠️ **The 253 roster people (`s-###` / `t-##`) cannot log in.** They get PII +
> memberships + personas but **no `auth_association` row**. Use the catalog users, the
> `demo-*` palette, or the `@example.org` fixtures for any login.

> ⚠️ **`/home/skelly/dev/saga-dash/docs/seed-ids-onboarding.md` is stale** — it documents
> 5 districts / 6 users. The live catalog has 10 / 10. Worth a docs PR.

### Seed entrypoints in `@saga-ed/iam-db`

| Script | What it does | Destructive? |
|---|---|---|
| `db:seed` | The **full** canonical seed — `deleteMany()`s every iam table + `DELETE FROM user_pii`, then rebuilds the whole catalog | ☠️ **YES** |
| `seed:registry` | Upserts the Permission/Policy **registry** by stable id | No |
| `seed:dev-user` | `dev@example.org` + an admin persona on the `demo` district | No (scoped to dev's own persona) |
| `seed:demo` | Additive Demo-District-only path (`seedDemoOnly`) — the 12 `demo-*` users | No |
| `seed:rep-training` | Additive `rep-training` district + admin + roster + grant reconcile (`seedRepTrainingOnly`) | No (deletes scoped to rep-training ids) |
| `seed:org` | One self-contained ad-hoc district (`Saga Demo` / `sagademo.test`), fresh random UUIDs | No (pure insert, no-op on re-run) |
| `seed:rep-anchors` | District anchor + 3 persona defs, for the `provision-district.yml` fanout | No |

---

## 2. Per-environment matrix — what actually runs

### 2a. synthetic-dev (local `ss` mesh) — ✅ **fully supported, the reference implementation**

Driven by `@saga-ed/saga-stack-cli` (`ss`). The seed registry lives at
`/home/skelly/dev/soa/packages/node/saga-stack-cli/src/core/seed/profiles.ts`.

```
ss stack bootstrap                 # ensure repos → overlay → up --reset --seed → verify
ss stack seed roster | full        # re-seed a running stack
ss stack seed full --with playback,qtf,authz
ss stack login empty@saga.org [--browser] [--slot N]
ss stack snapshot store --fixture-id <name> / restore <name>
ss stack reset                     # ☠️ truncate data DBs + reseed
```

Profiles:
- `roster` = `iam-registry` → `iam-dev-user` → **`iam` (the full destructive `db:seed`)** → `sessions`
- `full` = the above + `programs`, `scheduling`, `content`, `coach-pg`
- add-ons: `playback` (transcripts/insights/chat), `qtf`, `authz` (OpenFGA bootstrap + tuples)

**Result:** the *entire* catalog — 10 districts, 20 schools, 44 sections, 10 catalog users,
12 demo users, `@example.org` fixtures, 253 roster people, programs/schedules/sessions/content.
Everything deterministic, everything `password123`.

**Login:** `AUTH_ENABLED` is off locally, so both `auth.devLogin` (email, no password) and
`auth.login` (email + `password123`) work. Slots 1–9 give fully isolated parallel stacks.

**Reset:** free and total. This is the only environment where truncate-and-rebuild is safe.

---

### 2b. wootdev / dev (`*.wootdev.com`) — ⚠️ **partial; CI seeds almost nothing**

CI deploys on merge to main. What the migrate one-shot actually runs:

| Service | dev-main migrate command | Seeds? |
|---|---|---|
| rostering `iam-api` | `iam-db db:deploy && iam-pii-db db:deploy && seed:registry && seed:dev-user` | registry + `dev@example.org` only |
| rostering `sis-api` | `db:deploy` | none (`sis-db` has no seed script) |
| program-hub `programs/sessions/scheduling/content-api` | `npm run db:deploy` | **none** — the workflows say verbatim *"NO seed — main/canary never seeds"* |
| SDS `ads-adm-api` | `/app/seed/sds/migrate-only.sh` | none |
| SDS `ledger-api` | self-migrates on boot | none |

**So CI gives dev exactly one identity: `dev@example.org`.** Everything else on dev is
**out-of-band**.

**But the full catalog *is* present on dev**, and the reason is structural: dev-main's iam
store resolves to the db-host-v2 container **`rostering-iam-canonical`** (live-verified
2026-07-21 via `ss env connect`, recorded in
`/home/skelly/dev/soa/claude/projects/gh_355/ss-env-reset-manual-test-plan.md`) — the same
canonical container `rostering/.github/workflows/cut-canonical.yml` rebuilds and every
sandbox restores from. Same for programs (`program-hub-programs-canonical`) and scheduling.
That is why `emptyOrg` and friends exist on `dash.wootdev.com` without CI ever running
`db:seed`. **This coupling is worth confirming with the platform owner** — it means a
`cut-canonical` re-cut and dev-main's data live in the same blast radius.

**PR previews & sandboxes are the *well*-seeded lane on dev:**
- `pr-preview-iam-api.yml` runs the full destructive `db:seed` against a
  **container-per-PR** DB → every preview gets the complete catalog deterministically.
- `sandbox-deploy.yml` honors the switchboard `seed-profile` contract: `''` = provision
  empty + live `db:seed`; `'canonical'` (the default when omitted) = restore the snapshot
  and skip the live seed.
- `provision-district.yml` mints an isolated representative district into a **named
  sandbox** (anchor via ECS RunTask + S2S roster fanout, `dry-run`/`canary`/`apply`,
  fenced against ever landing in shared main — rostering#774).

**Login:** `AUTH_ENABLED=true` on every deployed env, so **`auth.devLogin` is FORBIDDEN**.
Use `auth.login` with email + `password123`. The janus perimeter (`gate.wootdev.com`)
fronts the browser plane.

**Reset:** **none.** No scheduled wipe or reseed exists anywhere for dev. Data accumulates
from usage. The prod→dev mirrors (postgres 13:30 UTC with PII scrub; mongo 13:00 UTC
**without** scrub — a known gap) restore into *separate* mirror instances and only reach
live services via a manual `bind_projects` dispatch.

**New capability (in flight):** `ss env` (soa#355, draft PR soa#356 — Phase 0 + Phase 1
live-verified on dev):
```
ss env list | discover | connect <store> | verify
ss env org status --env dev --org emptyOrg --url iam=…    # read-only footprint
ss env org reset  --env dev --org emptyOrg [--dry-run|--yes] [--snapshot]   # ☠️ surgical
```
Targets orgs by **catalog slug only** (UUID derived, never typed) so hand-built orgs are
structurally untargetable. Catalog today: **`emptyOrg` only**. The live dry-run enumerated
980 org-reachable rows across 6 stores.

---

### 2c. training (`*.saga-training.org`) — ⚠️ **partial; deliberately additive-only**

A persistent tenant in the **dev AWS account**, on the `saga-training.org` apex. Every
redeploy is a manual `gh workflow run deploy-<svc>-training.yml --ref main`. Nothing
deploys on push. Reference: saga-iac `references/training-apex.md`.

**Data-state policy (explicit):** deploys **may** run expand/contract migrations and
additive, idempotent seeds; deploys **never** carry a destructive data operation.

| Service | training migrate command | Seeds? |
|---|---|---|
| rostering `iam-api` | `db:deploy ×2 && seed:registry && seed:dev-user && **seed:rep-training**` | registry + `dev@example.org` + the whole `rep-training` district |
| rostering `sis-api` | migrate only | none |
| program-hub `sessions-api` | `db:deploy && **db:seed:run**` | canonical bake — projections, authz rows, interactable pods |
| program-hub `content-api` | `db:deploy && **db:seed:run**` | yes |
| program-hub `programs/scheduling-api` | `db:deploy` | none |
| SDS `ledger-api` | boot-migrate | none (empty by design) |
| SDS `ads-adm-api` | **absent from the apex** — in flight (sds#282 + hipponot/iac#580) | — |
| coach `coach-api` | `dev-migrate.js` | none |

`db:seed` (the roster wiper) is **explicitly excluded** from every training caller, with a
long comment block in `deploy-iam-api-training.yml` explaining why. Consequently **the full
10-district catalog does not exist on training.** What's there is `rep-training` (seeded),
`demo`-district users like `demo-dadmin@saga.org` (present — the sessions-api training
workflow depends on them — but they arrived **out-of-band**, not from any current CI path),
a hand-built "co-resident big district", and Jenny's hand-built training orgs. The workflow
comment says it plainly: *"the training roster is managed out-of-band."*

**Login:** same as dev — `auth.login` email + password. **No janus perimeter** on this apex
(no `gate.`), so no gate cookie needed.

**Reset:** one sanctioned destructive path — `rostering/.github/workflows/reset-training-data.yml`
(rostering#843). It drives the db-host-v2 orchestrator `profiles`/`snapshot`/`restore`
verbs to restore a service's **whole DB container** to a named baseline, guarded by a
literal `confirm: RESET-TRAINING-DATA` input plus an automatic safety snapshot. **Pilot
scope: `sis-api` only.** As of 2026-07-20 all 14 live training Postgres containers carry
the profile `training-baseline-2026-07-20`.

> **Granularity is the problem here:** training's DBs are per-service db-host-v2 containers,
> so reset is *a whole service DB*, never *an org*. Restoring `sis` to baseline would also
> revert everything Jenny's orgs accumulated since. No org-scoped purge exists anywhere in
> the fleet today.

---

### 2d. production — ❌ **no demo data, by design**

| Service | prod migrate command | Seeds? |
|---|---|---|
| rostering `iam-api` | `prod-migrate.js … db:deploy ×2 && **seed:registry**` — and stops there | registry only. The `seed:dev-user` step is deliberately dropped on the prod branch |
| program-hub `programs/sessions/scheduling-api` | `prod-migrate.js … db:deploy` | none — *"prod data is canonical"* |
| SDS `ads-adm-api` / `ledger-api` | `prod-migrate.js … db:deploy` | none |
| coach `coach-api-canary` | `prod-migrate.js … db:deploy` | none |

Additional prod-only posture:
- `AUTH_ENABLED=true` and `DEV_PERIMETER_ENABLED` **forced off**; a boot guard
  (`assert-production-config.ts`) refuses to start prod with the dev fallbacks on.
- `/inspect` is wired behind `IsProd → NoValue` so the surface fail-safe 404s.
- Prod runs on RDS with **IAM-token auth** (no static `DATABASE_URL` secret), migrations
  wrapped in `dist/prod-migrate.js` as the `*_owner` role.
- Different AWS account, behind the `SagaProdMax` boundary. `ss env` supports **`dev` and
  `training` only** — prod is an explicit non-goal
  (`soa/packages/node/saga-stack-cli/src/core/env/registry.ts`).

**There is currently no supported way to create demo users in production, and no mechanism
in flight.** Any "eventually in prod" plan is greenfield.

---

## 3. Summary matrix

| | synthetic-dev | wootdev (dev) | training | prod |
|---|---|---|---|---|
| **Full catalog present?** | ✅ all 10 districts | ✅ — but via the `*-canonical` DB containers, not CI | ❌ `rep-training` + out-of-band only | ❌ none |
| **Seeder that runs** | `db:seed` (destructive) | `seed:registry` + `seed:dev-user` | + `seed:rep-training`, `db:seed:run` (sessions/content) | `seed:registry` only |
| **Destructive seed allowed?** | ✅ always | ✅ previews/sandboxes only | ❌ never on deploy | ❌ never |
| **`devLogin` (no password)** | ✅ | ❌ FORBIDDEN | ❌ FORBIDDEN | ❌ FORBIDDEN |
| **`auth.login` + `password123`** | ✅ | ✅ | ✅ | n/a (no seeded users) |
| **Perimeter** | none | janus `gate.wootdev.com` | none | inner IAM session only |
| **Whole-env reset** | `ss stack reset` | ❌ none | `reset-training-data.yml` (sis-api pilot) | ❌ never |
| **Org-scoped reset** | n/a | 🟡 `ss env org reset` (emptyOrg, draft soa#356) | 🔜 design target | ❌ |
| **Snapshot/restore** | `ss stack snapshot` | `seed-profile: canonical` | db-host-v2 profiles | ❌ |

---

## 4. The gaps, named

1. **No additive whole-catalog seeder.** `db:seed` is all-or-nothing and destructive; the
   only additive district seeders are `seed:demo` and `seed:rep-training`, each hardcoded
   to one slug. There is no `seed:district --slug <x>` .
2. **Training and dev diverge by *accident*, not policy.** Training's catalog content
   arrived out-of-band; dev's arrived by living on the canonical containers. Neither is
   reproducible from a workflow dispatch.
3. **PII env is a silent failure mode.** `seed.ts` *skips PII entirely* unless
   `PII_DEK_HEX`/`PII_HMAC_KEY_HEX` (or the runtime `PII_CRYPTO_PIIDEKHEX` /
   `PII_CRYPTO_PIIHMACKEYHEX` names) are set. Since `auth.login` resolves accounts by
   **email hash in the PII store**, a seeded admin can "exist" and still be unable to log
   in. This is the single most common demo-user failure.
4. **`seed:org` mints random UUIDs** — it's the one seeder that breaks the determinism
   contract, so its districts can't be cross-referenced by any other service.
5. **Cross-service coverage is uneven.** Even where iam has the users, programs-api and
   scheduling-api are migrate-only on both dev-main and training, so a seeded admin can
   have no programs to administer (this is the exact class of bug
   `deploy-sessions-api-training.yml`'s `db:seed:run` was added to fix).
6. **`RESETTABLE_ORGS` has one entry.** `ss env org reset` only knows `emptyOrg`.
7. **Prod has no story at all.**

---

## 5. Recommendation — how to get one consistent demo-user set in all four

The pattern to generalize already exists and is proven in production-adjacent use:
**`seedRepTrainingOnly`** (`/home/skelly/dev/rostering/packages/node/iam-db/prisma/seed.ts`,
`seedRepTrainingOnly`). It takes one catalog district slug and additively upserts the
district + schools + sections + admin persona + grants + roster + PII, with every delete
scoped to that district's derived ids. It is safe on a persistent shared DB. That is
exactly the primitive needed — it's just hardcoded to `rep-training`.

**Step 1 — parameterize it (rostering, small).**
Turn `seedRepTrainingOnly` into `seed:district --slug <catalogSlug>` (env var
`SEED_DISTRICT_ONLY=<slug>`), driven entirely off the catalog slices it already computes
(`DISTRICTS.filter`, `SCHOOLS.filter`, `SECTIONS.filter`, `ROSTER.filter`,
`USERS.filter(u => u.districtSlugs.includes(slug))`, `DISTRICT_ADMIN_PERSONA[slug]`). Keep
`seed:rep-training` as a thin alias so training's workflow doesn't churn. Add the same for
the `demo-*` palette (generalize `seedDemoOnly` the same way, or fold it in).

**Step 2 — pick the demo-user set and freeze it as a named profile.**
Define a small, explicit set rather than "the whole catalog" — the whole catalog is 253
roster people and is wrong for a shared persistent env. Suggested `demoSet`:

| slug | email | why |
|---|---|---|
| `demo` district → `demo-dadmin` | `demo-dadmin@saga.org` | district admin, full palette; already the de-facto training admin |
| `demo-dadmin-ro` | `demo-dadmin-ro@saga.org` | limited/observer admin — permission-boundary testing |
| `demo-lead-north` | `demo-lead-north@saga.org` | lead tutor |
| `demo-tutor-1` | `demo-tutor-1@saga.org` | tutor |
| `demo-student-1` | `demo-student-1@saga.org` | student |
| `emptyOrg` district → `empty` | `empty@saga.org` | first-run / upload-from-scratch; **already** the `ss env org reset` target |
| `rep-training` district → `rep-training` | `rep-training@saga.org` | realistic-district review |

All `password123` (dev/training), all deterministic ids, all derivable offline.

**Step 3 — wire it into each environment's existing vehicle.** No new deploy machinery:

- **synthetic-dev:** already covered by `db:seed`. Optionally add a `demo` seed add-on to
  `ADDON_STEPS` in `soa/packages/node/saga-stack-cli/src/core/seed/profiles.ts` so
  `ss stack seed roster --with demo` gives the same narrow set as the shared envs — that's
  what makes local *match* dev/training rather than being a superset.
- **wootdev:** append `&& pnpm --filter @saga-ed/iam-db seed:district --slug demo …` to
  `deploy-iam-api.yml`'s **dev branch** migrate command (it is additive and idempotent, the
  same class as the `seed:dev-user` already there). Do the same for the program-hub side
  *only if* you want programs to exist — that's a policy change to "main/canary never
  seeds" and needs Seth's sign-off.
- **training:** append the same slugs to `deploy-iam-api-training.yml`'s existing chain,
  next to `seed:rep-training`. This is the **lowest-risk, highest-value single change** —
  it converts training's out-of-band roster into a reproducible one.
- **prod:** do **not** put this in the deploy path. If prod demo users are genuinely
  needed, do it as a separate approval-gated `workflow_dispatch` (the
  `provision-district.yml` shape), with a distinct district slug and a distinct email
  domain so a prod demo account can never be confused with a real one — and get a decision
  on password auth in prod first, since prod is SSO-shaped.

**Step 4 — close the PII trap.** Make the seeders **fail loud** when the PII crypto env is
absent instead of silently skipping, or at minimum print a `⚠️ PII skipped — these accounts
cannot log in` banner. This is cheap and removes the most common demo-user failure.

**Step 5 — extend `RESETTABLE_ORGS`.** Add `demo` (and later `rep-training`) to
`soa/packages/node/saga-stack-cli/src/core/env/seed-ids.ts` so `ss env org status/reset`
covers the demo set, not just `emptyOrg`. Growing that list is a reviewed code change by
design — which is the guard that keeps Jenny's hand-built orgs untargetable.

**Sequencing:** Step 1 → Step 4 → Step 3-training → Step 3-dev → Step 5 → Step 2-freeze
in docs. Steps 1 and 4 are one small rostering PR; step 3-training is a one-line workflow
edit; everything else follows.

---

## Pointers

- Catalog: `/home/skelly/dev/rostering/packages/core/iam-seed-ids/src/catalog.ts`
- Full seed + all additive paths: `/home/skelly/dev/rostering/packages/node/iam-db/prisma/seed.ts`
- **Credentials doc (canonical, non-stale by construction):** `/home/skelly/dev/rostering/packages/node/iam-db/prisma/README.md`
- Local seed registry: `/home/skelly/dev/soa/packages/node/saga-stack-cli/src/core/seed/profiles.ts`
- Deployed-env registry: `/home/skelly/dev/soa/packages/node/saga-stack-cli/src/core/env/registry.ts`
- Resettable orgs: `/home/skelly/dev/soa/packages/node/saga-stack-cli/src/core/env/seed-ids.ts`
- Training policy: saga-iac `references/training-apex.md` (plugin cache `~/.claude/plugins/marketplaces/saga-tools/plugins/saga-iac/references/`)
- Sandbox seed profiles: saga-iac `references/sandbox-seed-profile.md`
- Prior research: `/home/skelly/dev/shared-env-reset-research.md`, `/home/skelly/dev/whats-left-to-repro-in-training.md`
- In-flight: soa#355 / PR soa#356 (`ss env`), rostering#843 (`reset-training-data.yml`), sds#280 (ads-adm on training)
