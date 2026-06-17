<!-- Snapshot of saga-dash PR #152 :: docs/seed-ids-local-mesh-runbook.md
     Source: saga-ed/saga-dash @ branch docs/seed-ids-onboarding
     Captured 2026-06-04. Trust the live PR if this diverges. -->

# Standing Up the Saga Mesh Locally with Canonical Seed-IDs

> **Companion to [`seed-ids-onboarding.md`](./seed-ids-onboarding.md)** (package/API/ID reference).
> This is the hands-on runbook: bring up several backend services on your laptop, seed each
> from the shared `@saga-ed/*-seed-ids` catalogs, and watch them correlate **by construction**.
>
> **Scope note (honesty):** Steps 1–5 (infra → install → seed → **correlation proof**) are
> grounded in the current repo state and runnable. Step 6 (saga-dash UI) is assembled from the
> current config (ports, flags, override mechanism) — caveats are called out inline; it is the
> *optional visual layer*, not the proof. The proof lives in Step 5 and needs no UI.
>
> **Just want the stack running? Use `synthetic-dev`.** `soa/tools/synthetic-dev/bootstrap.sh` is
> the team's one-command, automated bring-up of this exact mesh — 6 services, pinned to the team's
> in-flight state, with a `verify.sh` and `./up.sh --login`. **This doc is the layer underneath:**
> what that tool automates, a manual path, and the part it doesn't cover — *why the IDs correlate by
> construction* (Step 5). One seam to know: synthetic-dev currently seeds via the **scenario runner**
> (non-deterministic UUIDs → re-login after every `--reset`), whereas the `db:seed` path here uses the
> **deterministic** seed-ids (stable UUIDs across reseeds). See
> [Relationship to synthetic-dev](#relationship-to-synthetic-dev).

---

## The idea (why this works)

Each service owns its own Postgres DB and **seeds only its own DB** from the canonical catalogs.
Because every UUID is `uuidv5("<kind>:<slug>", ROOT_NAMESPACE)` (or a fixed literal), two services
compute the **same id for the same slug** — so a program's `organizationId` equals the iam district's
id with **no service calling another at seed time, no `IAM_API_URL`, and no ordering dependency**.
Stand the services up in any order; the data lines up.

**The local mesh:**

| Service | Repo | Local port | Seeds from |
|---|---|---|---|
| iam-api (+ iam-pii) | rostering | **3010**¹ | `iam-seed-ids` (districts/schools/sections/users/roster) — the producer |
| programs-api | program-hub | **3006** | `iam-seed-ids` (org ids) + `program-seed-ids` (programs/periods) |
| scheduling-api | program-hub | **3008** | `program-seed-ids` (sessions/slots) |
| content-api *(optional)* | program-hub | 3010 | `content-seed-ids` — see [Appendix](#appendix--content-api-optional) |
| saga-dash *(optional UI)* | saga-dash | **8900** | consumes the above; log in as a seeded user |

¹ iam-api's binary defaults to `:3000`, but the team (and saga-dash's `config.json`) run it on
**`:3010`** — set `PORT=3010`. This doc uses `:3010` throughout (matching `synthetic-dev`).

---

## Prerequisites

- **Node ≥22** for rostering/program-hub (Prisma 7 rejects older), **Node 24+** for saga-dash; `corepack` pnpm.
- **Docker** (the mesh Postgres/Redis/RabbitMQ run in containers).
- **AWS SSO + CodeArtifact.** The cross-repo seed-ids deps are published `0.1.0-dev.0`, so each repo
  must auth to CodeArtifact before `pnpm install`:
  ```bash
  aws sso login                  # account 396913734878
  cd ~/dev/<repo> && pnpm co:login   # writes the CodeArtifact token into npm config
  ```
  (`co:login` is defined in each repo's root `package.json`; rostering's `.npmrc` already pins the
  `@saga-ed:` scope to the `saga_js` CodeArtifact registry.)

---

## Step 1 — bring up shared infra (one command)

```bash
cd ~/dev/soa/infra
make up PROJECT=saga-mesh PROFILE=empty      # make down to stop, make reset to wipe
```
Spins up (see `soa/infra/Makefile`, `compose/projects/saga-mesh/`):
- **Postgres** `:5432` — superuser `postgres_admin` / `password123`
- **Redis** `:6379`, **RabbitMQ** `:5672` (mgmt `:15672`, `rabbitmq_admin`/`password123`)
- **Empty databases** (`compose/projects/saga-mesh/seed/profile-empty.sql`):

  | DB | owner / password | used by |
  |---|---|---|
  | `iam_local` | `iam` / `iam` | iam-api |
  | `iam_pii_local` | `iam_pii` / `iam_pii` | iam-api (PII) |
  | `programs` | `saga_user` / `password123` | programs-api |
  | `scheduling` | `saga_user` / `password123` | scheduling-api |
  | `ads_adm_local`, `ledger_local`, `sis_db` | (per owner) | SDS / future |

  > ⚠️ There is **no `content` database** in the mesh seed — content-api needs one created manually
  > (see [Appendix](#appendix--content-api-optional)).

**Connection strings** (used below):
```
iam        postgresql://iam:iam@localhost:5432/iam_local
iam-pii    postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local
programs   postgresql://saga_user:password123@localhost:5432/programs
scheduling postgresql://saga_user:password123@localhost:5432/scheduling
```

---

## Step 2 — install each repo

```bash
cd ~/dev/rostering   && pnpm co:login && pnpm install && pnpm build
cd ~/dev/program-hub && pnpm co:login && pnpm install && pnpm build
```
`pnpm build` (turbo) compiles workspace siblings the seeds need (e.g. `rostering-client`,
`program-seed-ids`); the cross-repo `iam-seed-ids` resolves from CodeArtifact.

---

## Step 3 — migrate + seed each service

Order doesn't matter for correlation (derivation is offline), but seed **iam first** by convention.
Each service reads `DATABASE_URL` from its `.env` — copy `apps/node/<svc>/.env.example` → `.env`
and point it at the mesh URLs above. You can also pass the URL inline as shown.

**iam-api (rostering)** — two DBs:
```bash
cd ~/dev/rostering/packages/node/iam-db
DATABASE_URL=postgresql://iam:iam@localhost:5432/iam_local         pnpm db:deploy   # migrate
cd ../iam-pii-db
DATABASE_URL=postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local pnpm db:deploy
cd ../iam-db
DATABASE_URL=postgresql://iam:iam@localhost:5432/iam_local \
PII_DATABASE_URL=postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local \
  pnpm db:seed    # also needs the dev PII keys from apps/node/iam-api/.env.example
```
`db:seed` materializes the whole catalog (5 districts, 13 schools, 28 sections, 6 users, 190 roster)
with **derived canonical UUIDs**, `source='canonical'`, `source_id=<slug>`.

**programs-api + scheduling-api (program-hub)** — one `db:seed` covers all program-hub services:
```bash
cd ~/dev/program-hub/apps/node/programs-api
DATABASE_URL=postgresql://saga_user:password123@localhost:5432/programs   pnpm db:deploy
cd ../scheduling-api
DATABASE_URL=postgresql://saga_user:password123@localhost:5432/scheduling pnpm db:deploy
cd ~/dev/program-hub
pnpm db:seed     # scripts/seed.sh seeds programs-api + scheduling-api (+ content if its DB exists)
```
**No `IAM_API_URL` needed** — the programs seed derives org ids offline from the slugs.

---

## Step 4 — run the services

Separate terminals (`pnpm dev` in each app dir):
```bash
# iam-api → :3010   (apps/node/iam-api/.env must set:)
#   PORT=3010  NODE_ENV=development  AUTH_AUTHENABLED=false  AUTH_SEEDMODE=true  JANUS_REQUIRED=false
#   AUTH_DEVUSERID=1e2ca0d8-8f6a-5a97-a141-b38d472a1186   # = userId('dev'); see Step 6 caveat
cd ~/dev/rostering/apps/node/iam-api && PORT=3010 pnpm dev

# programs/scheduling THROW at startup without IAM_API_URL (they verify iam JWTs via JWKS), and
# circuit-break/die without a reachable broker. Launch each with BOTH:
cd ~/dev/program-hub/apps/node/programs-api && \
  IAM_API_URL=http://localhost:3010 \
  RABBITMQ_URL=amqp://rabbitmq_admin:password123@localhost:5672 pnpm dev   # :3006
cd ~/dev/program-hub/apps/node/scheduling-api && \
  IAM_API_URL=http://localhost:3010 \
  RABBITMQ_URL=amqp://rabbitmq_admin:password123@localhost:5672 pnpm dev   # :3008
```
> The mesh broker is `rabbitmq_admin@:5672`; the apps default to the wrong `saga_user@:5673`, so the
> `RABBITMQ_URL` override is mandatory or programs/scheduling die after ~5 min (synthetic-dev drift #7).

Health check: `curl localhost:3010/health`, `:3006/health`, `:3008/health`.
iam-api **refuses to boot unless `NODE_ENV=development`** when auth is disabled (production guard).

---

## Step 5 — prove the integration (the point)

Demonstrate the **same UUID across services, with no service running and no HTTP**:

```bash
# 1. Derive the canonical 'seed' district id (pure function, offline):
cd ~/dev/rostering
node --input-type=module -e "import {deriveGroupId} from '@saga-ed/iam-seed-ids/derive'; console.log(deriveGroupId('seed'))"
#   → 71698462-2be8-5eb8-9d7c-443bd59d0c3f

# 2. iam-api WROTE it as a canonical district:
psql "postgresql://iam:iam@localhost:5432/iam_local" \
  -c "select id, source, source_id, display_name from groups where source='canonical' and source_id='seed';"
#   → 71698462-2be8-5eb8-9d7c-443bd59d0c3f | canonical | seed | Seed District

# 3. programs-api REFERENCED it (note quoted camelCase columns — Program has no @@map):
psql "postgresql://saga_user:password123@localhost:5432/programs" \
  -c "select id, \"organizationId\", name from \"Program\" order by name;"
#   → the 'seed'-district programs (Lincoln Fall, Roosevelt A/B) have organizationId = 71698462-...
```

**Punchline:** all three are `71698462-2be8-5eb8-9d7c-443bd59d0c3f`. programs-api computed it
**offline** — iam-api wasn't consulted, `IAM_API_URL` was unset, and the seed order was irrelevant.
That is "integrate through the packaged seed-ids." The same holds down the chain: scheduling →
programs via `programId(slug)`, content → `contentId(slug)`, and roster people via `personId('s-137')`.

---

## Step 6 — see it in saga-dash (optional UI)

> **Caveat:** this section is assembled from saga-dash's current config (`config.json`, auth
> middleware) — confirm the two knobs below in your checkout. The Step 5 proof stands on its own.

```bash
cd ~/dev/saga-dash && pnpm dev      # Vite on :8900
```

**Knob 1 — the iam port.** saga-dash's `apps/web/dash/static/config.json` `localDefaults` expect
**iam on `:3010`** — which is exactly where Step 4 runs it (`PORT=3010`), matching the team /
synthetic-dev convention. So **no override is needed**: `program-hub`→3006 and `scheduling-api`→3008
line up too. (If you instead leave iam on its `:3000` binary default, repoint saga-dash with
`http://localhost:8900/?iam=localhost:3000` or the gear-icon override panel — `VITE_ENABLE_OVERRIDES`
is on in dev.)

**Knob 2 — local auth.** iam-api's middleware: with `AUTH_AUTHENABLED=false`, a **valid session
cookie still wins**; only requests *without* a cookie fall back to `AUTH_DEVUSERID`. So:
- **Log in as a specific canonical user (recommended):** with `JANUS_REQUIRED=false` the employee
  gate is off, so a real login cookie takes precedence over the dev fallback. Easiest: open
  **`http://localhost:3010/demo#auth`** and devLogin as `many@saga.org` / `password123` (synthetic-dev
  wraps this as **`./up.sh --login`**, which mints the session and opens a logged-in Chromium). Then
  open `http://localhost:8900`.
- **Auto dev-user (no login):** set `AUTH_DEVUSERID` to a **seeded** id — for this `db:seed` path that's
  `userId('dev')` = `1e2ca0d8-8f6a-5a97-a141-b38d472a1186` (lands you in as `dev@saga.org`, seed
  district). ⚠️ The shipped `.env.example` value (`f0000004-…-009`) is **not** in the `db:seed` roster
  → `whoami` returns an unseeded id → empty dashboard. (synthetic-dev's *scenario* seed path uses a
  different dev user — `…beef` + its own dev-user seeder — because it doesn't run `db:seed`.)

**Canonical users** (all `@saga.org`, password **`password123`**):

| user | district(s) | why |
|---|---|---|
| `many` | metro | **richest** — many programs/schedules |
| `dev` | seed | default happy path |
| `multi` | seed + riverside | cross-district switching |
| `new` / `frontier` / `none` | oakdale / frontier / — | empty-state & edge cases |

---

## Reset / re-seed

Re-running `pnpm db:seed` rebuilds a service's data (the seeds use `deleteMany` — a destructive local
reset; fine on the mesh). `make reset` in `soa/infra` drops everything and re-creates the empty DBs.
Because ids are **deterministic**, reseeding produces the **same UUIDs** — saga-dash overrides,
bookmarks, and any hardcoded `userId('dev')`/`groupId('seed')` stay valid across reseeds. That
stability is the whole point.

---

## Troubleshooting (verified rough edges)

- **`programs-api`/`scheduling-api` throw `IAM_API_URL … is required` at boot** → launch them with
  `IAM_API_URL=http://localhost:3010` (Step 4). They also **circuit-break and die** without a reachable
  broker → set `RABBITMQ_URL=amqp://rabbitmq_admin:password123@localhost:5672` (mesh broker; apps
  default to the wrong `saga_user@:5673`).
- **iam port** → run iam on `:3010` (Step 4) to match saga-dash + synthetic-dev; only override if you
  leave it on its `:3000` default.
- **`AUTH_DEVUSERID` stale in `.env.example`** → set it to `userId('dev')` = `1e2ca0d8-…-1186` (db:seed path).
- **content-api** → no `content` DB in the mesh + its `:3010` now collides with iam → see Appendix; skip for the golden path.
- **Node version** → Prisma 7 needs Node ≥22 (rostering/program-hub); saga-dash needs Node 24+.

---

## Appendix — content-api (optional)

content-api postdates the mesh seed, so:
```bash
# 1. create its DB (absent from profile-empty.sql):
psql "postgresql://postgres_admin:password123@localhost:5432/postgres" \
  -c 'create database content owner saga_user;'
# 2. migrate + seed (program-hub's pnpm db:seed picks it up once the DB exists):
cd ~/dev/program-hub/apps/node/content-api
DATABASE_URL=postgresql://saga_user:password123@localhost:5432/content pnpm db:deploy
cd ~/dev/program-hub && pnpm db:seed        # seeds the 12 canonical content items by contentId()
# 3. run it → :3010
```
content-api isn't in saga-dash's `services.json` on main, so it's **off the UI golden path**. Its
default `:3010` now collides with iam (which Step 4 runs on `:3010`) — if you run content-api too,
give it a non-default port (`PORT=3011`) and override in the UI.

---

## Relationship to synthetic-dev

`soa/tools/synthetic-dev` is the **automated, team-canonical** way to run this mesh: `./bootstrap.sh`
pins everyone to the same in-flight state, brings up the same stack (plus **sis-api** and
**ads-adm-api**), runs `verify.sh`, and `./up.sh --login` drops you into an authenticated dash. Prefer
it for day-to-day work; the manual steps above exist to explain/customize what it does.

**Today it seeds via the scenario runner** (`scripts/scenarios`), which assigns IDs at create time, so
**every `--reset` mints new UUIDs** (hence its "re-login after every reset") — it does *not* use the
seed-ids `db:seed`. That's the one seam between the two.

**The target model is layered, not either/or** — scenarios stay first-class, but on top of a
canonical base:
- **Base layer = seed-ids `db:seed` (deterministic).** Orgs, schools, sections, users, roster,
  programs, content — stable UUIDs that correlate across services and match what the AWS preview/CI
  mesh restores from canonical snapshots. Stable across reseeds → no re-login churn for the base.
- **Journey layer = scenarios (on top).** Enrollments, schedules, sessions, attendance flows — the
  dynamic, per-run state a test/demo exercises. Scenarios **reference the canonical seed-ids**
  (`groupId('seed')`, `programId('lincoln-fall')`, `personId('s-137')`) for the foundational entities
  instead of minting their own, then layer journey state on top.

Pointing synthetic-dev's base seed at `db:seed` and making the scenarios seed-ids-aware would make
**local == preview == CI** and retire the base-roster re-login churn — while keeping scenarios for
journeys. See [`seed-ids-synthetic-dev-convergence.md`](./seed-ids-synthetic-dev-convergence.md).

---

## Reference

| Thing | Path |
|---|---|
| Package/API/ID reference | [`seed-ids-onboarding.md`](./seed-ids-onboarding.md) |
| Automated stack (canonical) | `soa/tools/synthetic-dev/` (`bootstrap.sh` · `up.sh` · `verify.sh`) |
| Local infra harness | `soa/infra/Makefile` · `soa/infra/compose/projects/saga-mesh/` |
| Original design + correlation proof | `rostering/claude/seed-scenario-handoff.md` (§5c, §6) |
| iam-api auth/janus config | `rostering/apps/node/iam-api/.env.example` · `src/middleware/auth.middleware.ts` |
| saga-dash local topology | `saga-dash/apps/web/dash/static/config.json` (`localDefaults`) |
