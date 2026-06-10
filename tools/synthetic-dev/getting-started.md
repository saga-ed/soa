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

## Fastest path — stand it up on main

**By default the stack runs every repo on `origin/main`.** No shared manifest,
nothing to coordinate — one command brings everything up, seeds a roster, and
verifies it's green:

```bash
cd ~/dev/soa/tools/synthetic-dev
./bootstrap.sh                 # ensure repos → (overlay if any) → up --reset --seed roster → verify
```

`bootstrap.sh` chains the steps (run them individually if you prefer):

```bash
./refresh-suite.sh             # apply your local overlay if present — else a no-op (everyone on main)
./up.sh up --reset --seed roster
./verify.sh                    # asserts 6 services @ 200 + roster + sis_db + SOURCE POSTURE (right branches); non-zero on any red
```

On a clean checkout there's no overlay, so `refresh-suite.sh` is a no-op and
every repo stays on `main`. You're done — skip to **TL;DR** below.

### Overlaying your own in-flight PRs (optional, per-developer)

When you want the stack to also carry **your own** not-yet-landed PRs, give each
repo's `local/integration` branch a base of `main` + those PRs. `refresh-suite.sh`
does it, two ways:

**Ad-hoc** (quickest — explicit PRs, no file):
```bash
./refresh-suite.sh --prs 165 saga-dash        # saga-dash main + PR #165
./refresh-suite.sh --prs 410,432 rostering    # several PRs in one repo
```

**Reproducible** (a set you re-apply as main moves) — a **personal, gitignored**
overlay file:
```bash
cp integration-suite.example.tsv integration-suite.local.tsv   # one-time
# edit integration-suite.local.tsv — one row per repo: <repo>\t<PR#s>
./refresh-suite.sh                                             # apply it (no args)
./refresh-suite.sh --list                                      # show what's overlaid
```

> **Why a *local* overlay and not a shared committed one?**
> `integration-suite.local.tsv` is `.gitignored` — it's **yours alone**, so your
> in-flight PRs never land on a teammate. (Earlier this was a single shared,
> source-controlled manifest so everyone ran the same pinned set; with several
> developers on the stack at once that file collides and churns, so the overlay
> is now per-dev and **main is the default**. Supersedes `decisions/d1.8`.)

**Maintenance:** when one of your overlaid PRs merges to `main`, delete its row
from `integration-suite.local.tsv` — the fix then arrives via `main` (up.sh's
`prep` pulls + builds the sibling repos), so it no longer needs replaying.

**Backing out entirely** (return to the all-main default): `./refresh-suite.sh
--reset` moves every overlaid repo back to `main` and deletes its disposable
`local/integration` branch. That leaves your overlay *file* alone — empty or
delete `integration-suite.local.tsv` too if you want the backout to stick across
the next `refresh-suite`. (Reset one repo with `--reset saga-dash`.)

> `refresh-suite.sh` leaves overlaid repos **on `local/integration`**; everything
> else stays on `main`. Both `up.sh`'s `check_branches` and `verify.sh` are
> **overlay-aware** — they expect exactly that, so the *correct* setup (including
> the no-overlay default) is silent. A `⚠` (or a `verify.sh` posture failure)
> means **real drift**: wrong branch, or an overlaid PR not actually merged into
> your `local/integration` (usually "forgot to re-run `refresh-suite.sh`").
> `verify.sh` makes this a hard, exit-code check; `check_branches` stays a
> warning so `up` still proceeds.

## TL;DR (steady-state, once you're set up)

```bash
./up.sh up --reset --seed roster   # from-scratch: roster, no programs
./up.sh --status                   # health + row counts
./up.sh --login                    # mint a session + open an auto-logged-in Chromium
./up.sh --down                     # stop services (mesh left up)
./refresh-suite.sh                 # re-apply your overlay after main moves (no-op if you have none)
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
   your overlay's PR numbers to branches via `gh`.
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
./bootstrap.sh                   # one-shot: ensure repos + (overlay if any) + up + seed + verify
./refresh-suite.sh               # apply your local overlay (no-op → everyone on main if you have none)
./refresh-suite.sh --list        # print your personal overlay, no changes
./refresh-suite.sh --prs 165 saga-dash      # ad-hoc: overlay explicit PR(s) onto main, no file
./refresh-suite.sh --reset       # back out: overlaid repos → main (deletes local/integration)
./verify.sh                      # assert 6 services + roster + sis_db + source posture (right branches) — exit code

./up.sh up                       # bring up mesh + 6 services (empty databases)
./up.sh up --reset --seed roster # from-scratch: empty baseline + synthetic IAM roster
./up.sh up --reset --seed full   # roster + 9 programs + periods + enrollment
./up.sh --reset                  # truncate synthetic data → empty baseline (services stay up)
./up.sh --seed roster            # seed against an already-empty stack
./up.sh --status                 # GET /health on each, iam user count
./up.sh --login [email]          # mint a session + open an auto-logged-in Chromium
./up.sh --down                   # stop services (mesh stays up)
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

1. `check_branches` — **overlay-aware** branch-posture warning: overlaid repos
   are expected on `local/integration`, the rest on `main` (the default), so the
   correct setup is silent; a `⚠` means real drift (warning only — `up` still
   proceeds; `verify.sh` makes posture a hard check + confirms overlays merged).
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
- **An overlaid PR conflicts on refresh:** `refresh-suite.sh` aborts that one
  merge and reports it (the rest still apply). Resolve it in the
  `local/integration` branch, or drop the offending PR from your overlay.
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
  (pinned integration suite = `d1.8`, now superseded by the per-dev local
  overlay + main-default described above; sis-api integration = `d1.7`,
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
