# Local synthetic-dev stack (sds_92)

A dockerized local stack (postgres + redis + rabbitmq + mongo + the ten
services) for developing **synthetic** iam rosters / programs / schedules —
no VPN, no prod-mirror fixture. Built 2026-05-26 in response to
`sources/prompt-3.md`.

The sixth API is **sis-api** (rostering, on main as of 2026-06 — Adam's
SIS reconciliation / CSV-roster service), added so it can be
cross-developed against saga-dash on this stack. See
`../decisions/d1.7`. The seventh is **sessions-api** (program-hub #148
harvest; soa#146). Eight + nine are the **Connect app** (qboard:
connect-api :6106 + connect-web :6210) — see getting-started.md's
Connect section for what's different (mesh-managed mongo :27037, no
fixtures, no proxy, recording deferred). Ten is **rtsm-api** (rtsm,
:6110) — Connect's CRDT/socket service as a local single-instance node
(stateless, no DB, auth off).

> **New here?** Read **`getting-started.md`** — onboarding + the
> one-command path (`./bootstrap.sh`) that stands the stack up **on `main`**
> (the default; up + seed + `verify.sh`). To overlay your own in-flight PRs,
> `refresh-suite.sh` reads a personal, gitignored `integration-suite.local.tsv`
> (or `--prs` ad-hoc) — see getting-started's "Overlaying your own in-flight
> PRs". This README is the deeper drift log + service map.

## TL;DR

```bash
./up.sh           # mesh + 10 services, EMPTY
./up.sh --reset --seed roster   # from-scratch: empty baseline, then synthetic IAM roster only (programs empty)
./up.sh --reset --seed full     # roster + programs/periods/enrollment
./up.sh --seed [roster|full]    # seed without resetting (roster = default; iam groups don't dedup — prefer --reset)
./up.sh --status  # health + row counts
./up.sh --down    # stop services (mesh stays up)
```

Branch posture (decision `../decisions/d1.1`): everything on **main**.
sds_92 is merged, so ads-adm now runs from the canonical
`~/dev/student-data-system` checkout (the sds_92 worktree was retired).

<details>
<summary><strong>What I need checked out</strong> — repos, branches & presumed locations</summary>

All paths are relative to `$DEV` (default `~/dev`; override by exporting
`DEV=...`). `up.sh` expects each repo cloned as a sibling under `$DEV` and
on the branch below — `check_branches` only **warns** on a mismatch, it
won't stop the run.

| repo | presumed location | branch | provides (port) |
|---|---|---|---|
| **soa** | `~/dev/soa` | `main` | mesh infra (`infra/` + `projects/saga-mesh/seed`) for pg/redis/rabbitmq; shared `@saga-ed/soa-*` packages (registry mode — `soa:link:off`) |
| **rostering** | `~/dev/rostering` | `main` | iam-api (**:3010**); **sis-api (:3100)** + sis-db prisma; iam-db / iam-pii-db prisma; the `program-hub` roster scenario (`scripts/scenarios`) |
| **program-hub** | `~/dev/program-hub` | `main`¹ | programs-api (**:3006**) + scheduling-api (**:3008**) + sessions-api (**:3007**); the `programs` scenario (`scripts/scenarios`) |
| **student-data-system** | `~/dev/student-data-system` | `main` | ads-adm-api (**:5005**); ads-adm-db prisma. Override the path with `SDS=...` |
| **saga-dash** | `~/dev/saga-dash` | `main` | dash web UI (**:8900**) |
| **qboard** | `~/dev/qboard` | `main` | connect-api (**:6106**) + connect-web (**:6210**); livekit/coturn compose (AV). Override the path with `QBOARD=...` |
| **rtsm** | `~/dev/rtsm` | `main` | rtsm-api (**:6110**) — Connect's CRDT/socket service, single-node here. Override the path with `RTSM=...` |

Mesh containers (`soa-postgres-1` / `soa-redis-1` / `soa-rabbitmq-1`) are
brought up from `soa` by `up.sh` itself — no separate clone.

¹ **program-hub** may legitimately sit on a `fix/…` branch carrying the
drift-#8 `iam_session`-cookie patch; that's fine — `up.sh` re-applies the
same fix idempotently. You'll just see a `⚠ … (expected 'main')` line.

</details>

## What's up when it's up

| service | port | repo / branch |
|---|---|---|
| iam-api | 3010 | rostering main (moved 3000→3010 to match saga-dash main's config — d1.4) |
| sis-api | 3100 | rostering main — SIS reconciliation / CSV-roster (d1.7); calls iam-api `service.*` (S2S, dev-bypass locally) |
| programs-api | 3006 | program-hub main |
| scheduling-api | 3008 | program-hub main |
| sessions-api | 3007 | program-hub main — sessions read/lifecycle (harvested from programs-api in program-hub #148); event-built projections (pre-existing data needs the one-time manual replay — see getting-started.md) |
| ads-adm-api | 5005 | student-data-system **main** (canonical checkout) |
| saga-dash | 8900 | saga-dash main |
| connect-api | 6106 | qboard main — Connect session API (Express + mongo; health at `/connectv3/v1/health`) |
| connect-web | 6210 | qboard main — Connect web app (vite); reaches local rtsm via `VITE_RTSM_BOOTSTRAP_URL` |
| rtsm-api | 6110 | rtsm main — ONE-NODE FLEET (`rtsm-fleet-local.json` via `FLEET_CONFIG_PATH`; rtsm-client requires `/fleet/discover`, which only fleet mode serves); stateless, no DB, `SOCKET_AUTHMODE=none` |
| postgres / redis / rabbitmq | 5432 / 6379 / 5672 (mgmt 15672) | soa-mesh (`soa-postgres-1` etc.) |
| mongo (connect) | 27037 | `soa-connect-mongo-1` — mesh-managed (infra-compose `services/connect-mongo`; standalone mongo:8, no auth; NOT the legacy saga-api/wootmath template, NOT qboard's :27017) |
| livekit / coturn | 7880 / — | qboard docker-compose (AV; best-effort — Connect runs CRDT-only without them) |
| recorder / recordings-api / minio / egress | 7890 (webhook 7889) / 8444 / 9000 / — | OPT-IN (`./up.sh --record [crdt|av]`) — fleek compose + local overlay from `~/dev/fleek`; recordings in `~/.fleek-local/recordings` |

Mesh rabbitmq creds: **`rabbitmq_admin:password123`** (not `saga_user`).
Eight empty DBs: `iam_local`, `iam_pii_local`, `programs`, `scheduling`,
`sessions`, `ads_adm_local`, `ledger_local`, `sis_db` (all created by the
canonical mesh seed — `sis_db` added in soa#112, d1.7; `sessions` in soa#146.
The seed only runs on first postgres init, so `up.sh` prep also ensures
`sessions` exists on meshes initialized before it was added).

## Status as of 2026-05-26 (after rostering + program-hub pulled to latest origin/main)

- ✅ Full stack stands up healthy (rostering #294, program-hub #98).
- ✅ **Synthetic IAM roster seeding works** — the rostering `program-hub`
  scenario creates 5 districts, 13 schools, 28 sections, district roles,
  6 named dev users, 168 students, 22 tutors (197 users / 46 groups /
  593 memberships).
- ✅ **Synthetic programs/schedules seeding now works** — the
  `auth.resolveSession` contract drift is **RESOLVED** upstream: iam-api
  now issues a JWT `iam_session` cookie and exposes JWKS; programs-api
  verifies the JWT locally (`iamAuth.userFromRequest`) instead of calling
  `resolveSession`. The program-hub `programs` scenario creates 9
  programs + 17 periods + enrollment against the synthetic roster. See
  `../decisions/d1.2` (RESOLVED).

## Drift log — why this isn't just `./student-data-system-demo.sh up`

The existing concierge predates the current mains. Every gap below is
applied idempotently by `up.sh`; several are **latent upstream bugs**
worth fixing in their repos.

1. **`SDS` path.** sds_92 is merged to main and its worktree retired, so
   `up.sh` now defaults `SDS=$DEV/student-data-system` (the canonical
   checkout). Override with `SDS=…` to run ads-adm from elsewhere.
2. **rostering main switch isn't dep-neutral.** main added
   `@aws-sdk/client-kms/-secrets-manager/-ses/-sts` + `jose` to iam-api
   and changed workspace-package exports → needs `pnpm install` + full
   `pnpm build` (concierge only rebuilds *seed* packages).
3. **iam-api dev launch lost a runtime asset — RESOLVED upstream.** The `dev`
   script's `--onSuccess` overrode the tsup config's copy of
   `password-blocklist.txt` (+ `clean:true` wiped `dist/`), ENOENT-ing the
   bundle's `fs.readFileSync`. Fixed on rostering main by **PR #302** (commit
   `bc2a2dd`, 2026-05-27); the dev script now copies the asset before `node`.
   `up.sh` no longer patches this.
4. **main iam-api requires new env.** `AUTH_EMAIL_LOOKUP_SECRET` /
   `AUTH_EMAIL_VERIFICATION_SECRET` (outside `NODE_ENV=development`) —
   absent from the concierge's `.env.local` template. Fix: add them +
   `NODE_ENV=development`.
5. **dev user must be a UUID.** `audit_log.actor` is `uuid`. Latest main
   now ships a UUID `.env.example` default (`…009`), but it differs from
   the seeder's id, so keep `AUTH_DEVUSERID=f0000004-0000-4000-8000-00000000beef`
   (the value `iam-db/src/seed-dev-user.ts` creates) + run the dev-user seeder.
6b. **programs-api + scheduling-api require `IAM_API_URL`.** Latest program-hub main
   hard-requires `IAM_API_URL` at startup (both verify iam JWTs via JWKS). `up.sh`
   launches both with `IAM_API_URL=http://localhost:3010` (the new iam port).
9. **iam-api moved to :3010 (2026-05-26).** saga-dash main's Janus auth rewrite points
   `static/config.json` iam at 3010; `up.sh` runs iam there (PORT in launch env + `.env`)
   and points programs/scheduling/scenarios at it. saga-dash now authenticates via tRPC
   (`iam.auth.whoami`/`people.me`/`groups.getByUser`) — no mock auth, no dev-login form.
   See `../decisions/d1.4`.
6. **rate limiter throttles bulk seeding.** `SECURITY_RATELIMITMAXREQUESTS=100`/min
   kills the 168-student create. Fix: raise it for dev seeding.
7. **rabbitmq port + creds mismatch.** Apps default to
   `amqp://saga_user:password123@localhost:5673`; the mesh broker is
   `rabbitmq_admin@:5672`. iam-api tolerates the miss (degraded);
   programs-api/scheduling-api **circuit-break and die** after ~5 min.
   Fix: launch them with `RABBITMQ_URL=amqp://rabbitmq_admin:password123@localhost:5672`.
   The `config/.env.development` value is `NODE_ENV`-gated and unreliable;
   the process-env override is authoritative.
8. **stale scenario scripts.** rostering `demo-small` omits the now-required
   district-membership `persona` — use the `program-hub` scenario, which sets
   personas. (The program-hub `programs.ts` `iam_session`-cookie issue that
   used to live here is **RESOLVED upstream** — program-hub **PR #102** (merge
   `d85aa2d`, on main as of 2026-05-27): the scenario reads/sends the JWT
   `iam_session` cookie natively. `up.sh` no longer patches it.)
10. **programs/scheduling DBs are provisioned via `migrate deploy`, not `db:push`.**
    `db:push` only mirrors `schema.prisma` and ignores `migrations/`, so
    migration-only DDL is silently never created — e.g. `RecurrenceRule`'s
    **partial** unique index `(scheduleId, periodId, rotationIndex) WHERE periodId
    IS NOT NULL` (migration `20260513120000`), which `reconcileExtraRotations`'
    `INSERT … ON CONFLICT` needs. Without it, `schedules.upsert` **500s with PG
    `42P10`**. Fix: `up.sh prep()` runs `pnpm db:deploy` (`prisma migrate deploy`)
    — the same command program-hub's ECS `migrate` job runs — via the `migrate_db`
    helper. A DB still on the old `db:push` footprint (no `_prisma_migrations`
    history) is converted once via `migrate reset` (then re-seed). See
    **`../decisions/d1.5`**. Surfaced 2026-05-27 driving the Schedule step after
    the program-hub main switch.

## Harness caveat

`up.sh` launches services with `nohup` (persists in a normal terminal).
When standing the stack up from *inside an agent tool-call*, foreground
`nohup`/`setsid` children get reaped on call-teardown — launch each
server as its own background task instead. This only affects agent-run
sessions, not you running `./up.sh` in a terminal.

## Seeding synthetic data

- **IAM roster:** `cd ~/dev/rostering && pnpm tsx scripts/scenarios/src/run.ts program-hub`
  (named dev users + 5 districts/13 schools/28 sections/168 students/22 tutors).
- **Programs/schedules:** `cd ~/dev/program-hub/scripts/scenarios && pnpm scenario:programs`
  — works on main (runtime auth fix #96 + scenario cookie fix #102; see `../decisions/d1.2`).
- To reset iam between runs (groups don't dedup): truncate `iam_local`
  public tables (keep `_prisma_migrations`) + `iam_pii_local.user_pii`,
  then re-run the dev-user seeder. `up.sh` does the dev-user seed.

## Files I changed (local, uncommitted — flag for upstream)

- `~/dev/rostering/apps/node/iam-api/package.json` — dev-script asset copy (drift #3)
- `~/dev/rostering/apps/node/iam-api/.env` — `AUTH_DEVUSERID` uuid, rate limit (drift #5,6)
- `~/dev/rostering/.env.local` — NODE_ENV + AUTH secrets + RABBITMQ_URL (drift #4,7)
- `~/dev/program-hub/apps/node/{programs,scheduling}-api/config/.env.development` — RABBITMQ_URL (drift #7; superseded by launch-env)
- rostering + program-hub `package.json`/`pnpm-lock.yaml` — earlier soa:link residue discarded (now registry mode against local soa main)

(program-hub `scripts/scenarios/src/programs.ts` is no longer changed locally — the
`iam_session` cookie fix landed upstream in PR #102; see drift #8.)
