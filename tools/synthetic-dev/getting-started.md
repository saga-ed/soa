# getting-started.md — synthetic-dev stack onboarding

This is the local "synthetic-dev" stack we use for the attendance-UI /
People-step work on saga-dash, and now for **cross-developing sis-api against
saga-dash**. It's a dockerized, fully-local **six-service** stack:

| port | service | repo |
|---|---|---|
| 3010 | iam-api | `~/dev/rostering` |
| 3100 | sis-api | `~/dev/rostering` |
| 3006 | programs-api | `~/dev/program-hub` |
| 3008 | scheduling-api | `~/dev/program-hub` |
| 5005 | ads-adm-api | `~/dev/student-data-system` |
| 8900 | saga-dash | `~/dev/saga-dash` |
| 5432 | postgres (`soa-postgres-1`) | mesh, from `~/dev/soa/infra` |
| 6379 | redis | mesh |
| 5672 / 15672 | rabbitmq | mesh |

Seeds a realistic synthetic roster: **7 districts / 15 schools / 32 sections
/ 168 students / 22 tutors / 7 named dev personas** — no PII, no VPN, no
prod-mirror fixture. The 7 dev personas are admin/PM accounts you log in as
(separate from the roster).

## Fastest path — land in the team's exact state

The stack runs against a `local/integration` branch in each repo = `main` +
a **pinned set of not-yet-landed PRs** (the curated subset we're all
developing against). One command reproduces that state, brings everything up,
seeds a roster, and verifies it's green:

```bash
cd ~/dev/soa/tools/synthetic-dev
./bootstrap.sh                 # refresh-suite → up.sh up --reset --seed roster → verify
```

`bootstrap.sh` chains three steps (run them individually if you prefer):

```bash
./refresh-suite.sh             # rebuild local/integration = main + the pinned PRs (integration-suite.tsv)
./up.sh up --reset --seed roster
./verify.sh                    # asserts 6 services @ 200 + roster + sis_db + SOURCE POSTURE (right branches, pinned PRs merged); non-zero on any red
```

> **Why `refresh-suite.sh` and not `refresh-integration.sh`?**
> `refresh-integration.sh` defaults to *your own* open PRs (`--author @me`) and
> picks up the **full** open set — so two engineers never match, and even one
> engineer gets WIP/prod-only branches we don't run locally. `refresh-suite.sh`
> applies the **pinned** PR numbers in `integration-suite.tsv` (author- and
> account-independent), so everyone lands identically. See `decisions/d1.8`.

The pinned suite (snapshot — `./refresh-suite.sh --list` for the live list):

| repo | pinned PRs |
|---|---|
| rostering | #410 (Empty Org seed — the truly-empty upload-from-scratch fixture) |
| saga-dash, program-hub, soa, student-data-system | none — stay on `origin/main` |

**Maintenance:** when one of these PRs merges to `main`, delete its line from
`integration-suite.tsv` — the fix then arrives via `main` (up.sh's `prep`
pulls + builds the sibling repos), so it no longer needs replaying. If that
was a repo's *last* pin (as rostering's #366 was), also `git checkout main`
in that repo so it leaves `local/integration` — `refresh-suite.sh` no longer
manages it.

> `refresh-suite.sh` leaves pinned repos (currently just **rostering**) **on
> `local/integration`**; unpinned ones (saga-dash, program-hub, soa,
> student-data-system) stay on `main`. Both `up.sh`'s `check_branches` and `verify.sh` are
> **manifest-aware** — they expect exactly that, so the *correct* setup is
> silent. A `⚠` (or a `verify.sh` posture failure) now means **real drift**:
> wrong branch, or a pinned PR not actually merged into your `local/integration`
> (usually "forgot to re-run `refresh-suite.sh`"). `verify.sh` makes this a hard,
> exit-code check; `check_branches` stays a warning so `up` still proceeds.

## TL;DR (steady-state, once you're set up)

```bash
./up.sh up --reset --seed roster   # from-scratch: roster, no programs
./up.sh --status                   # health + row counts
./up.sh --login                    # mint a session + open an auto-logged-in Chromium
./up.sh --down                     # stop services (mesh left up)
./refresh-suite.sh                 # re-pull the pinned PRs after main moves / a PR updates
```

Then open `http://localhost:3010/demo#auth` → **devLogin** as `dev@saga.org`
(Seed District admin), then `http://localhost:8900`. Or just `./up.sh --login`,
which mints the session and opens a Chromium already logged into the dash.

## sis-api (the sixth service)

sis-api (`~/dev/rostering/apps/node/sis-api`, on rostering `main`) is the SIS
reconciliation / CSV-roster service. `up.sh` stands it up on **:3100** against
a dedicated `sis_db`. It calls iam-api's `service.*` S2S surface — and works
locally with **no service credentials**, because iam-api's auth middleware
synthesizes a dev-bypass service actor when auth is disabled (which is how we
run iam-api here). `sis_db` is created by the canonical mesh seed (soa#112)
alongside the other app DBs. See `decisions/d1.7`.

To cross-develop sis-api ↔ saga-dash: edit either repo, the dev servers
hot-reload (sis-api via `tsup --watch`, dash via Vite HMR). The dash already
knows where sis-api lives — `up.sh` seeds a `sis-api → :3100` entry into
saga-dash's `static/config.json`.

## Walkthrough deck (start here for the UX flow)

`../training/saga-dash-walkthrough.html` — open in a browser or serve via
`../training/serve-docs.sh` (it shells out to `python3 -m http.server` on
`:8080`, prints the URL). The deck walks the Program Setup flow end-to-end —
**People → Schedule → Groups → Sessions** — driven as `dev-user` against the
synthetic Seed District roster, with collapsible **Technical notes** panels
documenting the endpoints/tables/types behind each step. Built from PNGs
captured by `../training/capture/capture.mjs` (regenerable; see
`../training/GENERATION.md`).

## Prereqs (one-time)

1. **Docker** daemon running.
2. **Node 22+** and **pnpm**.
3. **`gh` CLI authenticated** (`gh auth status`) — `refresh-suite.sh` resolves
   the pinned PR numbers to branches via `gh`.
4. **AWS CLI** + IAM credentials with read access to Saga's CodeArtifact
   (the npm registry for the private `@saga-ed/*` packages). Without it
   `pnpm install` in rostering/program-hub/saga-dash will 401 on every
   private package. Get a fresh token any time with
   `pnpm co:login` (defined in each repo's root `package.json`).
5. **Five sibling repos cloned under a shared parent**, by default `~/dev/`:
   ```
   ~/dev/
     ├── soa                  # mesh infra (provides docker compose for pg/redis/rabbitmq)
     ├── rostering            # iam-api + sis-api + iam-db / sis-db
     ├── program-hub          # programs-api + scheduling-api
     ├── saga-dash            # the dash itself
     └── student-data-system  # ads-adm-api + this synthetic-dev tooling
   ```
   Override the base with `DEV=~/work ./bootstrap.sh`.
6. Each sibling repo's `pnpm install` should succeed at least once (post-
   token-refresh). `up.sh` reruns this idempotently for rostering on every
   `up` because the branch switch isn't dep-neutral; for the others a one-time
   `pnpm install` in each repo gets you started.

## Does it handle a clean Docker state?

**Yes.** `mesh_up()` checks for `soa-postgres-1` running; if it isn't, it
shells out to:

```bash
( cd $SOA/infra && make up PROJECT=saga-mesh PROFILE=empty \
    POSTGRES_PORT=5432 REDIS_PORT=6379 RABBITMQ_PORT=5672 RABBITMQ_MGMT_PORT=15672 )
```

That's the canonical soa-mesh compose definition. So with zero containers
running and Docker just booted, `./up.sh up` does the right thing in one
command — brings up the mesh, applies prisma schemas (via `migrate deploy`
— matches the deployed pipeline; see `decisions/d1.5`), launches all six
services with the right env, and reports green.

## Verbs

```bash
./bootstrap.sh                   # one-shot: pinned PRs + up + seed + verify
./refresh-suite.sh               # rebuild local/integration = main + pinned PRs (all repos)
./refresh-suite.sh --list        # print the pinned suite, no changes
./verify.sh                      # assert 6 services + roster + sis_db + source posture (right branches, pins merged) — exit code

./up.sh up                       # bring up mesh + 6 services (empty databases)
./up.sh up --reset --seed roster # from-scratch: empty baseline + synthetic IAM roster
./up.sh up --reset --seed full   # roster + 9 programs + periods + enrollment
./up.sh --reset                  # truncate synthetic data → empty baseline (services stay up)
./up.sh --seed roster            # seed against an already-empty stack
./up.sh --status                 # GET /health on each, iam user count
./up.sh --login [email]          # mint a session + open an auto-logged-in Chromium
./up.sh --down                   # stop services (mesh stays up)
./refresh-integration.sh saga-dash         # YOUR open PRs (per-author; prefer refresh-suite for the shared set)
./refresh-integration.sh --prs 95 saga-dash # ad-hoc: scope to specific PR numbers
```

A reset re-seeds iam users with **new UUIDs**, so any browser session you
had will 401. Re-login at `localhost:3010/demo#auth` (or `./up.sh --login`)
after every `--reset`.

The reset is data-only — it truncates synthetic rows but **preserves
`_prisma_migrations`**, so it doesn't re-run schema setup. Fast.

## Personas (login at `localhost:3010/demo#auth`)

| email | role |
|---|---|
| `dev@saga.org` | Seed District admin (the default — most things work) |
| `multi@saga.org` | belongs to multiple districts (seed + riverside) |
| `many@saga.org` | admin for many programs (metro) |
| `new@saga.org` | district admin for a fresh district (oakdale) |
| `frontier@saga.org` | admin for the Frontier district |
| `empty@saga.org` | Empty Org admin — district with NO schools/sections/roster (the CSV upload-from-scratch fixture; `./up.sh --reset --seed roster --login empty@saga.org`) |
| `none@saga.org` | belongs to no district |

Each persona's UUID is printed at the end of every `--seed roster` run.

## What `up` actually does, step by step

1. `check_branches` — **manifest-aware** branch-posture warning: pinned repos
   are expected on `local/integration`, unpinned on `main`, so the correct
   setup is silent; a `⚠` means real drift (warning only — `up` still proceeds;
   `verify.sh` makes posture a hard check + confirms the pins are merged).
2. `apply_fixes` — idempotent edits for known main-vs-tooling drifts (see
   the **Drift log** at the bottom of `README.md`); also writes
   `SIS_DATABASE_URL` and seeds the dash's `sis-api → :3100` config key.
3. `mesh_up` — starts soa-mesh if not running.
4. `prep` — `pnpm install + build` in rostering / program-hub; `prisma migrate
   deploy` for iam / programs / scheduling / sis / ads-adm DBs (via the
   `migrate_db` helper — matches what `_deploy-ecs-api.yml`'s migrate job runs
   on production).
5. `services_up` — launches the six API services / dash with the right
   env (IAM_API_URL, RABBITMQ_URL, JWT_ACCESSTOKENTTLSECONDS, etc.) via
   `nohup pnpm dev` per service. PID files in `/tmp/sds-synthetic/`.

Logs land in `/tmp/sds-synthetic/<service>.log` — tail those when something
goes sideways.

## Common operations

```bash
# What's the state?
./up.sh --status                          # ports + iam user count
./verify.sh                               # same, but asserts (exit code)

# Stop everything
./up.sh --down                            # services down, mesh stays up
docker compose -f ~/dev/soa/infra/compose/projects/saga-mesh.yml down  # mesh too

# Tail a service
tail -f /tmp/sds-synthetic/sis-api.log

# Re-seed only (services already up)
./up.sh --reset --seed roster

# After ANY reset → re-login
open http://localhost:3010/demo#auth      # or ./up.sh --login
```

## When something breaks — known caveats

`README.md` has a **Drift log** explaining the historical gaps between the
concierge and current mains and what `up.sh` patches around. The
short-list of things to know:

- **CodeArtifact tokens expire** every ~12 h. If `pnpm install` 401s,
  `pnpm co:login` in the affected repo refreshes it.
- **Re-login after every `--reset`** (cookie ↔ user_id mismatch).
- **A pinned PR conflicts on refresh:** `refresh-suite.sh` aborts that one
  merge and reports it (the rest still apply). Resolve it in the
  `local/integration` branch, or drop the offending PR from the manifest.
- **Vite cache stickiness:** if you ship a code change in saga-dash and
  HMR shows it merged but the browser still behaves old, the per-package
  `.vite` optimize-deps caches are the usual culprit. Quick recipe: kill dash,
  `rm -rf apps/web/dash/node_modules/.vite packages/web/pages/*/node_modules/.vite`,
  restart, "Empty Cache and Hard Reload" in DevTools (Ctrl+Shift+R alone
  is NOT enough). `up.sh --reset` clears these for you.
- **`up.sh` runs under `nohup`** — fine in a terminal. If you wrap it in
  another process supervisor, the children can get reaped on parent
  teardown. Just run it in your shell.

## Where to look for more

- `README.md` (this directory) — the full drift log + service map + why
  the script exists.
- `../decisions/` — RESOLVED decision docs that shaped the stack
  (pinned integration suite = `d1.8`, sis-api integration = `d1.7`,
  provisioning via migrate deploy = `d1.5`, programs↔iam auth contract
  = `d1.2`, branch posture = `d1.1`, etc.).
- `../plans/` — design plans (e.g. the saga-dash Internal/External-SIS
  wiring that landed as saga-dash#97).
- `../training/saga-dash-walkthrough.html` — the deck.

## Quick sanity-check on a fresh machine

After cloning the 5 sibling repos and ensuring CodeArtifact + `gh` auth work:

```bash
cd ~/dev/soa/tools/synthetic-dev
./bootstrap.sh
# expect: refresh-suite green → 6 services @ 200 → "all checks passed"
```

If any service is red, `verify.sh` tells you which; tail its log under
`/tmp/sds-synthetic/`. If iam is red, 9 times out of 10 the AUTH_* env vars in
`~/dev/rostering/.env.local` need a refresh — `up.sh apply_fixes` writes a
working template if absent.

Holler if you hit anything that isn't in the drift log — odds are you've
found drift the rest of us haven't run into yet, and we'd rather track it.
