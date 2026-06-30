# Research 01 — synthetic-dev script inventory

> Evidence-based inventory of `~/dev/soa/tools/synthetic-dev` as the migration baseline for the OCLIF CLI. ~3,447 lines across 6 bash scripts (pure bash + curl + jq + docker — no framework).

## Executive summary

**synthetic-dev** is a bash-orchestrated local stack for developing across the Saga suite. It brings up **10 services** on-demand via `pnpm dev` + a docker-compose **mesh** (postgres/redis/rabbitmq/mongo), seeds them with deterministic synthetic data, and provides **PR-overlay** mechanisms for in-flight work.

## Script inventory

### bootstrap.sh (142 lines) — one-command setup
New-engineer gateway; chains provision → overlay → up → verify.
- `./bootstrap.sh [--no-refresh] [--seed roster|full]`, `DEV=~/work ./bootstrap.sh`
- `ensure_repos()` (76–122): clone missing of 7 siblings (`soa rostering program-hub saga-dash student-data-system qboard rtsm`), `pnpm co:login`, `pnpm install`. Worktree-aware (`.git` as file).
- Calls: `refresh-suite.sh` → `up.sh up --reset --seed` → `verify.sh`.

### up.sh (2,139 lines) — stack orchestration & service launcher
The core "concierge". CLI surface:
```
./up.sh                       # mesh + 10 services empty
./up.sh up --pull             # ff-only sync siblings, build, migrate
./up.sh --reset               # truncate to empty baseline
./up.sh --seed [roster|full]  # deterministic synthetic data
./up.sh --login [email]       # mint session + open Chromium
./up.sh --down                # stop services (mesh stays up)
./up.sh --status              # health + row counts
./up.sh --record [crdt|av] / --with-playback / --with-qtf-demo / --tunnel
./up.sh restart               # clean restart (no wipe)
./up.sh --only <svc> --sandbox <name>   # one service local, rest in cloud
./up.sh --workspace <file.json>         # switchboard manifest (hybrid)
```
Repo-path env vars (all overridable, default `DEV=$HOME/dev`): `SOA ROSTERING PROGRAM_HUB SAGA_DASH SDS QBOARD RTSM FLEEK`.

**Port / service map** (up.sh 182–246):

| Service | Port | Repo | Notes |
|---|---|---|---|
| iam-api | 3010 | rostering | moved 3000→3010 for dash main (d1.4) |
| sis-api | 3100 | rostering | S2S to iam-api |
| programs-api | 3006 | program-hub | |
| scheduling-api | 3008 | program-hub | |
| sessions-api | 3007 | program-hub | event-built projections, demo sessions |
| content-api | 3009 | program-hub | poll/content store |
| ads-adm-api | 5005 | student-data-system | session integration |
| saga-dash | 8900 | saga-dash | Vite dev |
| connect-api | 6106 | qboard | MongoDB connectv3 (:27037) |
| connect-web | 6210 | qboard | Vite |
| rtsm-api | 6110 | rtsm | CRDT/socket; one-node fleet |
| postgres/redis/rabbitmq/connect-mongo | 5432/6379/5672/27037 | soa mesh | `soa-*-1` containers |
| livekit + coturn | 7880 | qboard | best-effort AV, optional |

**State** (293–299): `STATE=/tmp/sds-synthetic` (logs, pids, `cookies.txt`, `browser-profile/`, `frpc.toml`); `.vms-moniker` gitignored.

**Execution flow:** arg parse/defaults → preflight (`check_branches` 314–363, `check_layout` 371–382, `apply_fixes` 396–480, `check_ports` 501–519) → `mesh_up` (521–566) → optional AV/record/restore → `pull_repos auto` (930–961) → `prep` install+build+migrate (963–1032) → `services_up` launch 10 (1373–1553, each `nohup pnpm dev` + 40s health poll via `launch` 1363–1371) → optional `reset_data` (1561–1598) → optional `seed_stack` (1735–1746) → optional `login_user` (1759–1784).

Workspace/sandbox machinery: `parse_workspace` (1100–1165), `sandbox_env` (1166–1211), `tunnel_env` (1242–1317), `want_service` (service filtering for `--only`).

### verify.sh (300 lines) — health & posture gate
`./verify.sh` (all checks) / `VERIFY_HEALTH_ONLY=1` (health+data only).
- **Health** (51–79): 10 `probe()` curls (e.g. `iam-api :3010 /health`, `connect-api :6106 /connectv3/v1/health`, `saga-dash :8900 /`).
- **Data** (81–122): pg reachable; `users>0`; canonical seed id `userId('dev')=1e2ca0d8-…-b38d472a1186`; `personas WHERE name='admin' >= 6`; `sis_db._prisma_migrations` present; connect-mongo ping.
- **Posture** (145–270, overlay-aware): reads `integration-suite.local.tsv`; managed repos expected on `local/integration` (+PRs merged) or `main`.
- **Freshness** (278–288): `git fetch` + count behind `origin/main`.
- Exit 0 pass / 1 fail; warnings don't affect exit.

### refresh-suite.sh (458 lines) — PR overlay & sandbox composition
Two jobs: (1) overlay PRs → `local/integration = origin/main + your PRs per repo`; (2) compose the complement (repos you're NOT editing) as a cloud sandbox.
- `./refresh-suite.sh [--list | --reset [repo...] | --prs <n,n|branch> <repo> | --compose-rest <name>]`
- Overlay file `integration-suite.local.tsv` (gitignored, TAB-separated `repo<TAB>PR#s`).
- `refresh_repo()` (125–195): fetch, `checkout -B local/integration origin/BASE`, resolve PR#→branch via `gh pr view`, `git merge --no-ff` each, track conflicts.
- `compose_rest()` (215–350+): expand `REPO_SERVICES` map, build jq request to `SANDBOX_API` (`sandbox-api.wootdev.com`), interactive (print spec, exit 2) or bypass-header POST + poll.

### tunnel.sh (269 lines) — multi-user VMS rendezvous
Expose local stack via frp reverse tunnels. `./tunnel.sh [up|down|status|moniker|urls]`. Moniker in `.vms-moniker`; per-svc `https://<svc>.<moniker>.vms.wootdev.com`; internal plane (pg/redis/rabbitmq/mongo) deliberately not tunneled. frp pinned `0.61.1`. AWS SSM `/vms/frp-token` `/vms/monikers`.

### test-workspace.sh (139 lines) — workspace-mode unit tests
Pure-function tests; extracts functions from up.sh via `sed`+`eval` (`want_service`, `parse_workspace`, `sandbox_env`, restore-map helpers). Notable as the **only existing test of the orchestration logic** — a model for what becomes unit-testable under OCLIF.

## Cross-cutting concerns (migration-relevant)

### Stack up/down
Mesh provisioned by **soa/infra**, not synthetic-dev: `cd $SOA/infra && make up PROJECT=saga-mesh PROFILE=empty POSTGRES_PORT=5432 …` (539–541). Services launched in-tree via `nohup pnpm dev`, pid files in STATE, killed on `--down` (mesh persists, separate lifecycle).

### Source PR/branch overlay
`local/integration` branch = `origin/main` + merged PRs, per repo. Repo path env-var overrides let you point at a clean `git worktree`. refresh-suite skips overridden repos.

### Seed data per subsystem
Profiles: **roster** (iam roster only) / **full** (roster+programs+content ±playback). Deterministic ids via `@saga-ed/iam-seed-ids` & `@saga-ed/program-hub` seed-ids → same UUIDs across synthetic-dev/preview/CI. Per-subsystem mechanism varies:

| Subsystem | Seed | Notes |
|---|---|---|
| iam (iam_local) | `pnpm db:seed` | 205 users, 6 personas, dev user |
| sis (sis_db) | migrate only | no local test data |
| programs | `pnpm db:seed` | offline, no iam dep |
| scheduling | migrate only | **no seed script yet** (empty on roster) |
| sessions | `pnpm db:seed` | demo projections + readiness warm row |
| content | `db:seed` + `seed-demo-polls.mjs` (HTTP) | catalog + demo polls |
| ads-adm | migrate only | lazy-populated at runtime |
| playback (transcripts/insights/chat) | `pnpm seed` each | opt-in `--with-playback` |
| connect (connectv3 mongo) | auto-create | sourced from sessions-api; reset drops DB |

Per-subsystem seed is **already modular** (each service owns its `db:seed`); what's missing is a declarative "which seed for which flow" layer.

### Ports / state / config
Hardcoded ports; `STATE=/tmp/sds-synthetic` (single-instance — the multi-instance concern is the sibling `multi-synthetic-dev` track). `apply_fixes` idempotently patches `.env.local` files (AUTH secrets, RABBITMQ_URL, rate limit, dash `config.json` sis-api entry).

### Mesh/infra coupling
8 app DBs created by mesh profile (`iam_local iam_pii_local programs scheduling sessions ads_adm_local ledger_local sis_db`). `migrate deploy` (not `db:push`) — d1.5. S3 snapshot restore (workspace mode) from `s3://saga-db-seeds-dev/<source>/profile-<profile>.sql`.

## Migration takeaways
1. **6 scripts, ~3.4k lines** of bash → the CLI must cover: bootstrap, up/down/restart/status, reset, seed, login, overlay (refresh-suite), verify, tunnel, workspace/sandbox.
2. **Service registry is implicit** — port/repo/health/db/seed knowledge is scattered through up.sh as parallel arrays and inline literals. A declarative **service manifest** is the natural extraction point and the enabler for N-of-M partial stacks.
3. **Seed is already per-service** (`pnpm db:seed`), so per-flow seed selection is a composition problem, not a rewrite.
4. **test-workspace.sh** proves the pure logic (filtering, parsing, env emission) is separable from side effects — good OCLIF command/service split.
5. **External deps**: docker/compose, pnpm, gh, aws (ssm/secrets/s3), curl, jq, mongosh, psql.
