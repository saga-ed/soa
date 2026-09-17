# 02 — How synthetic-dev seeds **today**

> Source: `~/dev/soa/tools/synthetic-dev/{README,getting-started,STATUS}.md`
> as of 2026-06-04. This is the "what we'd be changing" baseline for the
> convergence in `03`.

## What synthetic-dev is

A fully-dockerized local stack — postgres + redis + rabbitmq + **six
APIs** — for developing against a **synthetic** roster (no PII, no VPN, no
prod-mirror fixture). Built 2026-05-26; relocated to
`~/dev/soa/tools/synthetic-dev` on 2026-06-03. Orchestrated by:

- `bootstrap.sh` — one-shot onboarding: `refresh-suite.sh` (pin in-flight
  PRs) → `up.sh up --reset --seed roster` → `verify.sh`.
- `up.sh` — mesh + 6 services; verbs `--reset`, `--seed roster|full`,
  `--status`, `--down`, `--login`.
- `verify.sh` — 15 checks (service health · data · source posture).
- `refresh-suite.sh` / `integration-suite.tsv` — pins each repo to `main`
  + named in-flight PRs.

### The six services

| service | port | repo / branch |
|---|---|---|
| iam-api | 3010 | rostering main (moved 3000→3010 to match saga-dash) |
| sis-api | 3100 | rostering main — SIS reconciliation / CSV-roster |
| programs-api | 3006 | program-hub main |
| scheduling-api | 3008 | program-hub main |
| ads-adm-api | 5005 | student-data-system main (canonical checkout) |
| saga-dash | 8900 | saga-dash main |
| postgres / redis / rabbitmq | 5432 / 6379 / 5672 | soa-mesh |

Seven empty DBs created by the canonical mesh seed: `iam_local`,
`iam_pii_local`, `programs`, `scheduling`, `ads_adm_local`,
`ledger_local`, `sis_db`.

## How it seeds today — the **scenario runner**

This is the seam. The base roster is built by **running scenarios**, not
`db:seed`:

- **IAM roster:** `cd ~/dev/rostering && pnpm tsx scripts/scenarios/src/run.ts program-hub`
  → 5 districts / 13 schools / 28 sections / district roles / 6 named dev
  users / 168 students / 22 tutors (197 users / 46 groups / 593
  memberships).
- **Programs/schedules:** `cd ~/dev/program-hub/scripts/scenarios && pnpm scenario:programs`
  → 9 programs + 17 periods + enrollment.

The scenario runner **assigns IDs at create time** → they are
**non-deterministic**. Consequence, documented verbatim in
`getting-started.md`:

> "A reset re-seeds iam users with **new UUIDs**, so any browser session
> you had will 401. Re-login at `localhost:3010/demo#auth` (or
> `./up.sh --login`) after every `--reset`."

The scenario files **import no seed-ids** — verified by Seth in the
convergence doc.

## Why this matters: local diverges from preview/CI

| | seeds via | foundational IDs | on reset |
|---|---|---|---|
| **synthetic-dev (local)** | scenario runner | assigned at create time → **non-deterministic** | **new UUIDs → re-login + reconfigure** |
| **`db:seed` (each service)** | `@saga-ed/*-seed-ids` derive | `uuidv5(...)` → **deterministic** | **identical UUIDs** |
| **AWS preview / CI mesh** | `db:seed` → canonical S3 snapshots | deterministic | restore = identical |

So **local already diverges from preview/CI**: preview/CI are built on the
deterministic seed-ids base; synthetic-dev still mints per-run UUIDs. That
divergence is the root of the "re-login after every `--reset`" friction
*and* means a local repro is not guaranteed to match a preview repro.

## The drift log — what `up.sh` already patches

synthetic-dev exists because the current mains don't "just work"
together. `up.sh` applies these idempotently (numbering from README):

1. **`SDS` path** — defaults `SDS=$DEV/student-data-system` (sds_92
   merged, worktree retired).
2. **rostering main switch isn't dep-neutral** — needs `pnpm install` +
   full `pnpm build` (new AWS SDK + `jose` deps).
3. **iam-api dev asset (`password-blocklist.txt`)** — RESOLVED upstream
   (rostering PR #302).
4. **main iam-api requires new env** — `AUTH_EMAIL_LOOKUP_SECRET` /
   `AUTH_EMAIL_VERIFICATION_SECRET` + `NODE_ENV=development`.
5. **dev user must be a UUID** — `AUTH_DEVUSERID=f0000004-…-beef` (the
   value `iam-db/src/seed-dev-user.ts` creates) + run the dev-user seeder.
6. **rate limiter throttles bulk seeding** — raise
   `SECURITY_RATELIMITMAXREQUESTS` for the 168-student create.
6b. **programs/scheduling-api require `IAM_API_URL`** at startup (JWT via
   JWKS) — launched with `IAM_API_URL=http://localhost:3010`.
7. **rabbitmq port + creds mismatch** — apps default to
   `saga_user@:5673`; mesh broker is `rabbitmq_admin@:5672`;
   programs/scheduling **circuit-break and die** without the override.
8. **stale scenario scripts** — use the `program-hub` scenario (sets
   personas), not rostering `demo-small`. (The `iam_session`-cookie issue
   RESOLVED upstream in program-hub PR #102.)
9. **iam-api moved to :3010** (2026-05-26) to match saga-dash's Janus auth
   rewrite config.
10. **programs/scheduling DBs need `migrate deploy`, not `db:push`** —
    `db:push` skips migration-only DDL (e.g. `RecurrenceRule`'s partial
    unique index) → `schedules.upsert` 500s with PG `42P10`. `up.sh`
    runs `pnpm db:deploy`.

> **Relevance to convergence:** drift #5 (the `…beef` dev user + separate
> seeder), #8 (scenario-vs-db:seed choice), and #10 (`migrate deploy` =
> the production seed path `up.sh` already mirrors) are exactly the points
> Seth's proposal touches. Drift #10 in particular shows `up.sh` is
> *already* converging on the deployed migrate/seed path — the convergence
> extends that posture from migrations to seeding.

## What's verifiable green today (STATUS 2026-06-02)

`verify.sh` = 15 checks: 6 service-health (all 200), data (iam
`users=197`, `sis_db` migrated), source posture (repos on right branches +
pinned PRs merged in). Pinned suite at capture: program-hub #126,
saga-dash #136.

## The harness caveat (operational, not convergence-related)

`up.sh` launches services with `nohup`; from inside an agent tool-call,
foreground `nohup`/`setsid` children get reaped on teardown — launch each
server as its own background task instead. Affects agent-run sessions
only.
