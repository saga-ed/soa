# getting-started.md — synthetic-dev stack onboarding

This is the local "synthetic-dev" stack we use for the attendance-UI /
People-step work on saga-dash, for **cross-developing sis-api against
saga-dash**, and now for the **Connect app**. It's a dockerized, fully-local
**ten-service** stack:

| port | service | repo |
|---|---|---|
| 3010 | iam-api | `~/dev/rostering` |
| 3100 | sis-api | `~/dev/rostering` |
| 3006 | programs-api | `~/dev/program-hub` |
| 3008 | scheduling-api | `~/dev/program-hub` |
| 3007 | sessions-api | `~/dev/program-hub` |
| 5005 | ads-adm-api | `~/dev/student-data-system` |
| 8900 | saga-dash | `~/dev/saga-dash` |
| 6106 | connect-api | `~/dev/qboard` |
| 6210 | connect-web | `~/dev/qboard` |
| 6110 | rtsm-api (single-node) | `~/dev/rtsm` |
| 5432 | postgres (`soa-postgres-1`) | mesh, from `~/dev/soa/infra` |
| 6379 | redis | mesh |
| 5672 / 15672 | rabbitmq | mesh |
| 27037 | mongo (`soa-connect-mongo-1`) | mesh (infra-compose `services/connect-mongo`) |
| 7880 | livekit (+ coturn) | qboard's docker-compose (AV; best-effort) |

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
./verify.sh                    # asserts 10 services @ 200 + roster + sis_db + connect-mongo + SOURCE POSTURE (right branches); non-zero on any red
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
./up.sh --with-playback --seed full   # ALSO run the sds_93 playback APIs, fixture-seeded (see below)
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

## sessions-api (the seventh service)

sessions-api (`~/dev/program-hub/apps/node/sessions-api`, on program-hub
`main`) serves the dash's `/sessions` page — `sessions.dayList` /
`rangeList`, the lifecycle commands (`start`/`end`/`cancel`), overrides, and
`adhoc.create`. It was harvested out of programs-api in program-hub #148
(2026-06). `up.sh` stands it up on **:3007** (the port saga-dash main's
`static/config.json` already expects) against a dedicated `sessions` DB of
event-built projections: it consumes `programs.*` / `scheduling.*` / `iam.*`
events over the mesh broker, and TutoringSessions materialize lazily from
(slot × pod × date). Until a schedule + pods exist, `dayList` legitimately
returns empty days. See soa#146.

One-time catch-up note: the outbox replay to late-joining consumers
(program-hub #160/#161) is a **manual, per-program CLI**, not automatic — a
freshly-bound queue has no backlog, so events published *before* sessions-api
first joined never reach it. On the canonical `--reset --seed` lane this
never matters (sessions-api is up before any program exists). But if your
mesh already had program data when sessions-api first started, replay it
once per program:

```bash
cd ~/dev/program-hub/apps/node/programs-api && \
  DATABASE_URL=postgresql://saga_user:password123@localhost:5432/programs \
  pnpm replay:program-outbox <programId>
cd ../scheduling-api && \
  DATABASE_URL=postgresql://saga_user:password123@localhost:5432/scheduling \
  pnpm replay:schedule-outbox <programId>   # only if a schedule existed
```

The running relay re-publishes; idempotent consumption makes it a no-op for
already-caught-up consumers.

## Connect (services eight + nine)

connect-api (`~/dev/qboard/apps/node/connectv3-api`, **:6106**) and connect-web
(`~/dev/qboard/apps/web/connectv3`, **:6210**) are the Connect session app
(whiteboard / CRDT / AV). Notes that differ from the other services:

- **No fixtures, no migrations** on the mongo side — Connect's collections
  auto-create on first write; the databases simply support running sessions.
  "Session data" comes from **sessions-api (:3007)**, and `--seed` runs
  sessions-api's `db:seed` (the Connect-demo **direct-projection** seed): it
  writes the demo programs/sessions projections AND the
  `projection_readiness` warm row straight to the DB, so reads work on the
  event-less db:seed lane (without it, every sessions read 408s "projection …
  is warming" and Connect's `/my-sessions` 500s). The demo sessions belong to
  the **`demo` district**, NOT the roster personas — log in as a `demo-*@saga.org`
  user (`demo-dadmin@saga.org` is the district admin → sees all of them; all
  loginable with `password123` / devLogin). **To reach them via the dash
  `/sessions` page, seed with `--seed full`**: the dash's program-list gate reads
  **programs-api** and redirects to `/programs/new/config` when your org has no
  programs — and only `--seed full` seeds the demo programs into programs-api
  (`--seed roster` seeds just the sessions-api projections, which Connect reads
  directly but the dash gate does not). Opening Connect by direct URL
  (`:6210/?slsid=…`) works on either seed.
- **Dedicated mongo.** Connect's mongo is part of the mesh (infra-compose
  `services/connect-mongo` → container `soa-connect-mongo-1`): standalone
  mongo:8, no auth, host port **:27037** (non-default on purpose, so it never
  contends with qboard's old `:27017` container or a system mongod). `mesh_up`
  starts it (and auto-removes the pre-mesh standalone `connect-mongo`
  container if one is lingering); `--reset` drops `connectv3` (the db
  connect-api's `MONGO_DB_NAME` default actually writes).
- **No HTTPS / domain-spoof proxy.** qboard's `scripts/proxy-dev.sh` (mkcert +
  /etc/hosts + ssl-proxy) exists only because that workflow authenticates at
  `.wootdev.com`. Here iam is local, so the `iam_session` cookie is host-scoped
  to `localhost` and reaches every port — Connect rides the same `--login`
  session as the dash. Janus is off (`JANUS_REQUIRED=false`), and connect-api
  verifies JWTs against local iam's JWKS (`JWT_ISSUER=https://iam.saga.org`).
- **AV (LiveKit):** `up.sh` starts qboard's `livekit` + `coturn` containers
  best-effort (`devkey`/`devsecret`). If they fail, Connect still runs
  whiteboard/CRDT-only.
- **RTSM is local** — rtsm-api runs on **:6110** as a **one-node fleet**
  (`rtsm-fleet-local.json` via `FLEET_CONFIG_PATH` + `FLEET_NODE_NAME=local`):
  rtsm-client always discovers via `GET /fleet/discover`, which only fleet
  mode serves — bare single-instance mode 404s the client. The node is the
  fleet's only member (mesh idle) and stays stateless: in-memory, no
  DB/redis, auth off, plain `ws://`. connect-web reaches it via
  `VITE_RTSM_BOOTSTRAP_URL=http://localhost:6110` (qboard plumbs that through
  to rtsm-client's `bootstrapUrl`, which overrides domain-based fleet
  discovery; `?rtsm_url=` on the Connect URL overrides per-tab). On a qboard
  checkout WITHOUT that plumb the env var is ignored and connect-web falls
  back to the wootdev.com fleet — graceful either way. Rooms are ephemeral by
  design (destroyed ~20s after the last client leaves); a restart loses
  nothing that matters.
- **Legacy poll content:** connect-api requires `SAGA_API_TARGET` (the poll
  endpoint is unauthenticated — no saga cookie needed). `up.sh` defaults it;
  export your own (e.g. `SAGA_API_TARGET=https://jw.wootmath.com`) to override.
  Goes away when content-api lands.
- **Recording is opt-in** — `./up.sh --record` brings up fleek's recorder +
  recordings-api + a MinIO S3 stand-in (CRDT recording); `--record av` adds
  the LiveKit egress sidecar (Chromium, 2 GiB /dev/shm) for AV. Needs the
  **fleek repo** as an OPTIONAL eighth sibling (`~/dev/fleek` — not required
  by the base stack, so bootstrap/posture don't demand it) and the AWS CLI
  (the recorder images build from source against CodeArtifact). The recorder
  observes the LOCAL RTSM via its `RTSM_BOOTSTRAP_URL` plumb (fleek
  `feat/rtsm-bootstrap-url`); recordings-api runs auth-off with a dev
  identity (no saga cookie here); recordings land in
  `~/.fleek-local/recordings`. qboard's `livekit.yaml` webhooks the local
  recorder unconditionally, so the non-recording stack is unaffected either
  way. Playback: connect-web is launched with
  `VITE_PLAYBACK_ASSET_BASE_OVERRIDE=http://localhost:8444`.
- **Deferred:** dash→connect session linking.

## Playback APIs — opt-in (`--with-playback`)

The sds_93 playback stack — **insights-api (:6301)**, **transcripts-api (:6302)**,
**chat-api (:6303)** (student-data-system) — serves session-derived data
(Glow/Grow insights, CU transcript segments + enrichment, queryable chat) over
tRPC + REST. It's **opt-in** so the default stack stays lean.

```bash
./up.sh --with-playback --seed full   # provision + launch + fixture-seed all three
./up.sh --with-playback --status      # the three show under "playback" in --status
```

- **DBs + roles:** each app owns `{insights,transcripts,chat}_local` + a
  least-privilege role (`{insights,transcripts,chat}_app`) on the mesh Postgres,
  created from each package's `packages/node/*-db/seed/local-bootstrap.sql` (the
  same idempotent SQL the SDS docker-compose uses; the mesh is an infra-compose
  Postgres, so it applies as-is). Migrations run as the mesh master
  (`postgres_admin`); the apps boot as their reduced-privilege role.
- **Seed:** rides `--seed full` (not `roster`). Each app's `bin/seed.ts` upserts
  deterministic fixtures from `@saga-ed/sds-fixtures` under slsid
  **`fixture-playback-001`**, so playback / saga-dash queries return non-empty
  results without a real CU run. Idempotent (upserts on unique keys).
- **RabbitMQ:** the apps validate `RABBITMQ_URL` at boot but log-and-continue if
  the outbox relay can't connect (non-prod), so the mesh broker satisfies them.
- **Query the seeded data** (auth is off locally — no cookie needed):
  ```bash
  curl -s 'http://localhost:6302/transcripts/v1/trpc/transcripts.segmentsBySession?input=%7B%22session_id%22%3A%22fixture-playback-001%22%7D'
  curl -s 'http://localhost:6301/insights/v1/trpc/insights.listInsights?input=%7B%22session_id%22%3A%22fixture-playback-001%22%7D'
  curl -s 'http://localhost:6303/chat/v1/trpc/chat.messagesBySession?input=%7B%22session_id%22%3A%22fixture-playback-001%22%7D'
  ```
- **`recording-extractor`** (the 4th sds_93 app, an SQS/S3 CRDT decoder) is **not**
  in the stack — it exposes only health endpoints (no queryable data routes) and
  has no seed; the three HTTP APIs above are what colleagues query.

## Multi-user access — tunnel mode (`--tunnel`)

Connect is multi-user; your stack is localhost. Tunnel mode bridges that: it
exposes the **browser-facing** services at stable public HTTPS names so other
people (a coworker joining your Connect session, QA, a second device) can use
*your running stack* — services keep running locally under `pnpm dev` with
HMR. Infra is one shared rendezvous box (`vms/README.md`); day-to-day:

```bash
./up.sh --reset --tunnel --seed roster --login
```

First run prompts for your **moniker** (standard: your initials — saved to the
gitignored `.vms-moniker`, registered automatically; the cert mint takes ~2
min once). After that your stack is at:

```
https://connect.<moniker>.vms.wootdev.com        # Connect web — share THIS
https://connect-api.<moniker>.vms.wootdev.com    # its API
https://rtsm.<moniker>.vms.wootdev.com           # CRDT/socket sync
https://iam.<moniker>.vms.wootdev.com            # login (/demo#auth for guests)
```

`./tunnel.sh status|urls|down` manages the tunnels alone (e.g. re-attach after
a laptop sleep).

**How a guest joins:** log in at `https://iam.<m>.vms.wootdev.com/demo#auth`
(any seeded persona), then open the Connect URL. An unauthenticated guest who
opens the Connect link directly gets bounced to that same demo page
(tunnel mode overrides `JANUS_LOGIN_HOST` — by default Connect would send
them to the REAL dev fleet's `login.wootdev.com`, which mints a session our
local iam can't verify and loops). After logging in on the demo page, re-open
the Connect link — the demo page doesn't auto-follow the `next=` param.

**Saga-employee guests, one cookie gotcha:** a browser that has used the real
dev fleet (or that hit the old redirect loop) carries an `iam_session` cookie
on `.wootdev.com`, which is ALSO sent to `*.<m>.vms.wootdev.com` alongside our
`.<m>.vms.wootdev.com` one — and connect-api reads the cookie name
`iam_session` (hardcoded), so the stale real-dev one can win and 401 you even
after a demo login. Fix: delete the `.wootdev.com` `iam_session` cookie in
devtools (or just use an incognito window for guesting).

Know these three caveats:

- **Tunnel env applies at launch** — `--tunnel` on an already-running stack
  warns and only affects newly-launched services; use `restart --tunnel` or
  `--reset --tunnel`. In tunnel mode the session cookie is domain-scoped to
  `.<m>.vms.wootdev.com`, so **log in via the tunnel URLs** (the `--login`
  flow does this automatically), not localhost.
- **AV rides the real fleek dev cluster** (`wss://*.fleek.wootdev.com`) —
  local LiveKit is unreachable from a guest's browser (WebRTC media is UDP),
  so tunnel mode auto-fetches the cluster creds (`qboard/fleek/livekit-creds`,
  Secrets Manager) and repoints connect-api. If the fetch fails (expired SSO)
  it warns and guests get CRDT-only — whiteboard/chat/sync still work.
  Caveat: with cluster AV, `--record av`'s local egress can't capture media
  (CRDT recording is unaffected).
- **Remote dash needs saga-dash PR #194** (the `url` service-override type +
  its dev-only `config.local.json` local-override seam) — pin it in
  `integration-suite.local.tsv` (`saga-dash<TAB>194`) until it lands. Tunnel
  mode then writes an **untracked** `static/config.local.json` (url-type
  localDefaults → the tunnel hosts) which the dash overlays onto the tracked
  `config.json`; a non-tunnel run removes it. No tracked-file edit, so the
  saga-dash tree stays clean (nothing to `git checkout` before
  `refresh-suite.sh`).

Prereqs: AWS SSO creds in the dev account (`aws sso login`) — tunnel
registration reads the shared frp token from SSM. The rendezvous box itself is
provisioned once for the whole team: `vms/README.md`.

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
5. **Eight sibling repos cloned under a shared parent**, by default `~/dev/`:
   ```
   ~/dev/
     ├── soa                  # mesh infra (provides docker compose for pg/redis/rabbitmq)
     ├── rostering            # iam-api + sis-api + iam-db / sis-db
     ├── program-hub          # programs-api + scheduling-api + sessions-api
     ├── saga-dash            # the dash itself
     ├── coach                # coach-api (:6105) + coach-web (:8800) + coach-db
     ├── student-data-system  # ads-adm-api + this synthetic-dev tooling
     ├── qboard               # connect-api + connect-web (+ livekit/coturn compose)
     └── rtsm                 # rtsm-api (Connect's CRDT/socket service; single-node here)
   ```
   Override the base with `DEV=~/work ./bootstrap.sh`.

   > `coach` is required — `up.sh`'s `check_branches` preflight exits 1 without
   > it. Note that `bootstrap.sh`'s own "ensure repos" step (and `ss stack
   > bootstrap`) currently clone only the other seven, so on a bare machine they
   > stop at that preflight. `clone-repos.sh` clones all eight.

   Starting from nothing? `clone-repos.sh` clones whichever of these you're
   missing (and reports the ones you already have). It needs only an
   authenticated `gh`, so you can run it before any repo is checked out:
   ```bash
   gh api -H 'Accept: application/vnd.github.raw' \
     /repos/saga-ed/soa/contents/tools/synthetic-dev/clone-repos.sh | bash
   ```
   Already have `soa`? Just `./tools/synthetic-dev/clone-repos.sh`. It's
   idempotent, `--dry-run` shows what it would do, and it never clones over an
   existing checkout or worktree. `bootstrap.sh` (and `ss stack bootstrap`)
   also clone missing siblings, but over SSH and only from inside `soa`.
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
command — brings up the mesh (postgres + redis + rabbitmq + connect-mongo,
plus qboard's AV containers), applies prisma schemas (via `migrate deploy` — matches the
deployed pipeline; see `decisions/d1.5`), launches all ten services with the
right env, and reports green.

## Verbs

```bash
./bootstrap.sh                   # one-shot: ensure repos + (overlay if any) + up + seed + verify
./refresh-suite.sh               # apply your local overlay (no-op → everyone on main if you have none)
./refresh-suite.sh --list        # print your personal overlay, no changes
./refresh-suite.sh --prs 165 saga-dash      # ad-hoc: overlay explicit PR(s) onto main, no file
./refresh-suite.sh --reset       # back out: overlaid repos → main (deletes local/integration)
./verify.sh                      # assert 10 services + roster + sis_db + connect-mongo + source posture (right branches) — exit code

./up.sh up                       # bring up mesh + 10 services (empty databases)
./up.sh up --reset --seed roster # from-scratch: empty baseline + synthetic IAM roster
./up.sh up --reset --seed full   # roster + 9 programs + periods + enrollment
./up.sh --reset                  # clean restart on current code: self-provisions (mesh + AV + prep), truncates data
SKIP_PREP=1 ./up.sh --reset      # …skipping the install+build pass (tight iteration loops)
./up.sh --seed roster            # seed against an already-empty stack
./up.sh --status                 # GET /health on each, iam user count
./up.sh --record                 # opt-in: fleek recording stack (CRDT tier — recorder + recordings-api + minio)
./up.sh --record av              # …plus the LiveKit egress sidecar (AV recording)
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
| `demo-dadmin@saga.org` | **Connect demo** `demo`-district admin — the persona for clicking into Connect: sees all demo programs/sessions on `/sessions` (**needs `--seed full`**) |
| `demo-lead-north@saga.org` | Connect demo North lead tutor — the tutor view of the demo sessions |

The roster personas above do **not** see the Connect demo sessions (those live
in the separate `demo` district — use a `demo-*` persona). Each persona's UUID
is printed at the end of every `--seed roster` run.

## What `up` actually does, step by step

1. `check_branches` — **overlay-aware** branch-posture warning: overlaid repos
   are expected on `local/integration`, the rest on `main` (the default), so the
   correct setup is silent; a `⚠` means real drift (warning only — `up` still
   proceeds; `verify.sh` makes posture a hard check + confirms overlays merged).
2. `apply_fixes` — idempotent edits for known main-vs-tooling drifts (see
   the **Drift log** at the bottom of `README.md`); also writes
   `SIS_DATABASE_URL` and seeds the dash's `sis-api → :3100` config key.
3. `mesh_up` — starts soa-mesh (postgres + redis + rabbitmq + connect-mongo)
   if not running; migrates away a pre-mesh standalone `connect-mongo`.
4. `connect_av_up` — qboard's livekit + coturn (AV, best-effort).
5. `prep` — `pnpm install + build` in rostering / program-hub / qboard / rtsm
   (builds log to `/tmp/sds-synthetic/<repo>-build.log`; qboard/rtsm build
   failures abort — their services import workspace `dist/` at launch);
   `prisma migrate deploy` for iam / programs / scheduling / sessions / sis /
   ads-adm DBs (via the `migrate_db` helper — matches what
   `_deploy-ecs-api.yml`'s migrate job runs on production). Connect and rtsm
   have no migrate step (mongo collections auto-create; rtsm has no DB).
6. `services_up` — launches the ten services with the right env
   (IAM_API_URL, RABBITMQ_URL, JWT_ACCESSTOKENTTLSECONDS, etc.) via
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
# expect: refresh-suite green → 7 services @ 200 → "all checks passed"
```

If any service is red, `verify.sh` tells you which; tail its log under
`/tmp/sds-synthetic/`. If iam is red, 9 times out of 10 the AUTH_* env vars in
`~/dev/rostering/.env.local` need a refresh — `up.sh apply_fixes` writes a
working template if absent.

Holler if you hit anything that isn't in the drift log — odds are you've
found drift the rest of us haven't run into yet, and we'd rather track it.
