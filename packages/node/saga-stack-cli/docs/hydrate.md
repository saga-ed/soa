# `ss stack hydrate` — real prod-shaped data in a local slot

`ss stack hydrate` replaces a local slot's Postgres databases with the contents of the
**daily prod mirror**, so a developer gets prod-shaped data across *every* store with no
per-store sync code and no fixture maintenance.

```bash
ss stack hydrate --slot 2                      # PREVIEW (default) — prints the plan, changes nothing
ss stack hydrate --slot 2 --execute            # prompt, then hydrate the default database set
ss stack hydrate --slot 2 --db coach_api --execute --yes
ss stack hydrate --set my-set --execute --yes --keep-previous
```

---

## What it is not

- **It does not make Coach reporting light up.** Prod itself has `group_track_map = 0` and
  `persona_assignment = 0`, so no restore of prod can populate that routing. That is a
  separate concern; a hydrate that "fails" because reporting is still empty has not failed.
- **It cannot fill Connect.** `connectv3` is mongo, on `soa-connect-mongo-1`; the mirror is
  Postgres-only.
- **It cannot fill `insights_local`.** There is no `insights_*` database in the mirror.

All three are printed in the command's own output rather than silently skipped.

---

## The mirror

The mirror is an RDS instance in the **dev** account (`396913734878`), private subnets,
PG 18.3, ~700 MB across 17 databases. It is **re-created daily** by a 13:30 UTC CloudFormation
cron that *replaces the instance* — so **both the endpoint and the master password change
every day**.

Hydrate therefore resolves everything at RUN TIME, on every invocation:

| what | where from |
| --- | --- |
| endpoint | SSM `/mirror/current/postgres-rds/endpoint` |
| port | SSM `/mirror/current/postgres-rds/port` |
| master secret ARN | SSM `/mirror/current/postgres-rds/master-secret-arn` |
| username + password | Secrets Manager, that ARN, JSON `{username, password}` |

Nothing is memoized across runs, written to the state dir, or added to the env registry —
the same stance `ss env connect` takes for the prod RDS endpoint. A value that can drift
must not be able to drift out of a CLI release.

Reachability is an **SSM port-forward through the dev jump host** (`Name=dev-shared-ecs-instance`),
whose security group is in the mirror's 5432 ingress. No VPN. The tunnel's local end
defaults to **15532** — deliberately not `ss env connect`'s 15432, so an open connect
session and a hydrate cannot collide.

---

## The view swap — the central structural fact

The daily cron scrubs the projects in iac's `SCHEDULED_SCRUB_PROJECTS`: rostering,
program-hub, student-data-system and coach. Every mapped database is view-swapped except
`openfga`, whose rules swap no table (checked against the mirror's catalog 2026-11-09).
**The `_real` tables hold raw data about real district students.**

In a scrubbed database the real table is renamed `{table}_real` and a **scrambled VIEW**
takes the original name. That means *both* source modes need a rename step, in opposite
directions — and either way the local result must be ordinary **writable tables** under the
names the app expects.

### `--source real`

**Lands raw student data on your machine. Not recommended.** Use `scrubbed` unless you have an
explicit reason to handle that data.

```
dump everything  →  staging
DROP VIEW public.users CASCADE;
ALTER TABLE public.users_real RENAME TO users;
```

The `_real` table carries the data *and* its own PK, FKs, indexes, defaults and sequence
ownership, so the renamed result is a complete, writable table. (Index and constraint
*names* keep their `…_real…` spelling — functionally irrelevant, cosmetically visible.)

### `--source scrubbed` (the default)

```
dump pre-data + data, --exclude-table-data for every *_real  →  staging   (real tables arrive EMPTY)
psql <mirror> -c 'COPY (SELECT "id","email" FROM public."users") TO STDOUT'
  | psql <staging> -c 'COPY public."users_real" ("id","email") FROM STDIN'   (parents first by FK)
dump post-data  →  staging                                       (indexes, FKs, triggers)
DROP VIEW public.users CASCADE;
ALTER TABLE public.users_real RENAME TO users;
<verify no *_real relation survived>
```

Things worth noticing:

1. **The unscrubbed rows never touch the local disk.** `--exclude-table-data` brings the
   `_real` *structure* across with zero rows, listed table by table and again as a wildcard over
   every schema. The rows that land come only from the mirror's scramble views.
2. **Constraints come after the rows.** Tables with their own data hold foreign keys into
   `_real` tables, and those cannot be added while the parent is empty. Holding post-data back
   until the copy is done is what lets the restore finish, and it validates every foreign key
   against the rows that actually landed.
3. **The rename is what preserves the constraints.** `CREATE TABLE … AS SELECT * FROM <view>`
   would lose PKs, FKs, indexes, defaults and sequence ownership.

The column list comes from the **`_real` table's `attnum` order**, enumerated live, so the
`COPY` is column-exact rather than trusting that the scramble view presents columns in the
same order. Generated columns are left out, and the server recomputes them.

A scrubbed copy differs from prod's schema in one way: NOT NULL is dropped from the columns the
scrub blanks to NULL (encrypted PII in `iam_pii_db.user_pii`, for example). Those columns are read
from the view definitions at run time. Local iam-pii reads of `user_pii` will likely error, because
those required encrypted values are NULL on the mirror's scrubbed copy.

Materialized views over `_real` tables arrive unpopulated, because the scrub empties them on the
mirror. Selecting from one errors until you run `REFRESH MATERIALIZED VIEW` locally.

`authz_db` is the slow one: its decision log took 82 minutes on 2026-11-09 and the tunnel dropped,
failing every database after it. Hydrate it on its own with `--db authz_db`, or leave it out.
`transcription_db` needs the `vector` extension, which the local Postgres image doesn't have.

---

## Database mapping

The mirror's names are **not** the local names. Only `coach_api`, `sis_db` and `openfga`
match. The map lives in `src/core/mirror/databases.ts` (pure, unit-tested against the
manifest) — never inlined in the command, because a wrong pair restores one service's schema
over another service's database.

| mirror | local | owner | default set |
| --- | --- | --- | --- |
| `scheduling_api` | `scheduling` | `saga_user` | ✓ |
| `sessions_api` | `sessions` | `saga_user` | ✓ |
| `iam_db` | `iam_local` | `iam` | ✓ |
| `programs_api` | `programs` | `saga_user` | ✓ |
| `authz_db` | `authz_local` | `authz` | ✓ |
| `openfga` | `openfga` | `postgres_admin` | — opt-in: the local schema is owned by the `openfga_migrate` sidecar |
| `coach_api` | `coach_api` | `coach_api_app` | ✓ |
| `transcription_db` | `transcripts_local` | `transcripts_app` | — opt-in: mapping **unverified**, and playback-only |
| `authz_sync` | `authz_sync_local` | `authz_sync` | ✓ |
| `iam_pii_db` | `iam_pii_local` | `iam_pii` | ✓ |
| `sis_db` | `sis_db` | `sis` | ✓ |
| `ads_adm` | `ads_adm_local` | `ads_adm` | ✓ |
| `ledger_api` | `ledger_local` | **`ledger`** (not `ads_adm`) | ✓ |
| `content_api` | `content` | `saga_user` | ✓ |
| `chat` | `chat_local` | `chat_app` | — opt-in: playback-only |

`--db` accepts either name of a pair, plus `default` and `all`. An unknown token is a hard
error — a typo must never silently hydrate less than you asked for.

---

## Per-database mechanics

Nothing touches the live database until the replacement is proven good.

```
DROP DATABASE IF EXISTS <db>__hydrate WITH (FORCE)      -- clean up a previous failed run
DO $$ … CREATE ROLE <owner> … $$                        -- idempotent
CREATE DATABASE <db>__hydrate OWNER <owner>

docker run --rm --network host -e PGPASSWORD postgres:18 bash -o pipefail -c \
  'pg_dump --host 127.0.0.1 --port 15532 … --format custom | pg_restore --host 127.0.0.1 --port <slot> … --no-owner --no-privileges --single-transaction'

<verify staging is non-empty>
<scrubbed mode only: COPY the scrambled rows, then restore post-data>
<view swap, per scrubbed table>
<ownership sweep to <owner>>
<grants + default privileges to <owner>>
<verify <owner> can INSERT into every table>
<verify no app-named relation is still a VIEW>
<scrubbed mode only: verify no *_real relation survived>

ALTER DATABASE <db> WITH ALLOW_CONNECTIONS false
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='<db>' AND pid<>pg_backend_pid()
ALTER DATABASE <db> RENAME TO <db>__pre_hydrate_<stamp>
ALTER DATABASE <db>__hydrate RENAME TO <db>
ALTER DATABASE <db> WITH ALLOW_CONNECTIONS true
DROP DATABASE <db>__pre_hydrate_<stamp> WITH (FORCE)     -- unless --keep-previous
```

A failure anywhere before the swap fails **that database only** and leaves the live one
exactly as it was. The whole report is emitted before the non-zero exit.

### Why an ephemeral host-networked container

`docker exec soa-postgres-1 pg_dump -h 127.0.0.1 …` cannot work: the mesh container sits on
a compose bridge network, so *its* `127.0.0.1` is itself, not the host holding the tunnel.
`docker run --rm --network host postgres:18` sees **both** the tunnel port and the slot's
published postgres port, so the whole transfer is one pipe with no dump file on disk.
(`--network host` is Linux semantics; Docker Desktop on macOS differs.)

The image is pinned to `postgres:18` — the **debian** variant, not `-alpine`:

- `pg_dump` older than its server is a hard error, and the mirror is 18.3;
- the pipelines run under `bash -o pipefail`, so a failing `pg_dump` cannot be masked by a
  succeeding `pg_restore`. Alpine's `sh` has no `pipefail`.

### Why connections must be blocked before the rename

Measured on a live slot: 5 **idle** prisma-pool backends sit on `content` / `programs` /
`scheduling` / `sessions` / `iam_local` indefinitely. `TRUNCATE` and `pg_restore --clean`
succeed against idle backends — which is why `ss stack reset` works against a running stack —
but `ALTER DATABASE … RENAME` fails with *"being accessed by other users"* on **any** open
session, idle included. `ALLOW_CONNECTIONS false` stops new ones appearing;
`pg_terminate_backend` evicts the existing ones; the rename retries a few times to absorb a
backend that has not been fully reaped yet.

### Ownership and grants — the named silent failure

A prod dump carries `ALTER … OWNER TO <prod_role>` and `GRANT … TO <service_role>` naming
roles that do not exist locally, so the restore runs with `--no-owner --no-privileges` **as
`postgres_admin`** (not as the owner: a prod dump can carry `CREATE EXTENSION`, event
triggers or publications a non-superuser cannot create).

That leaves everything owned by `postgres_admin` — readable, and **not writable by the app**.
That failure surfaces days later as a 500. So hydrate then:

1. re-owns every object to the database's single service role (measured: each local database
   has exactly one app role owning the database *and* every object in `public`),
2. grants tables + sequences + functions + default privileges to it,
3. and **asserts** it with `has_table_privilege(<role>, …, 'INSERT')` across every restored
   table, failing the database if any comes back false — while the live database is still
   untouched.

---

## Guards

| guard | override | alternative |
| --- | --- | --- |
| `--slot 0` (including a bare `--slot`) is refused | none | `ss stack cold-start` resets slot 0 |
| non-local target (repointed `$SAGA_MESH_POSTGRES_CONTAINER`, non-loopback host, wrong port) | none | unset the override |
| slot's postgres container not running | none | `ss stack up --slot N` |
| wrong AWS account | none | a profile resolving to the dev account (`396913734878`) — `dev_admin` is an example name, not an issued profile |
| a scrubbed database enumerates zero `_real` tables (the daily scrub has not landed yet) | none | wait ~30 min and re-run — see [The scrub gap](#the-scrub-gap) |
| a database the map calls unscrubbed has `_real` tables on the mirror | none | update `src/core/mirror/databases.ts` |
| `--source scrubbed`: a table known to be scrubbed stands on the mirror as an ordinary table | none | find out why the daily scrub no longer covers it |
| another driver's live claim on the slot | `--yes` | wait, or `ss stack slots` |
| destructive confirm | `--yes` | — |

A **declined prompt** is an abort: exit 0, "hydrate aborted — nothing changed". The
structural refusals above are `this.error` → exit 2. A per-database failure emits the full
report, then exits 1.

### The scrub gap

The mirror's endpoint is published to SSM **before** the daily scrub renames each app table to
`{table}_real` and lays a scramble view over it. A hydrate started inside that window fails
discovery:

```
enumerated ZERO _real tables in iam_db, but it is a scrubbed database — expected at
least 12 (e.g. auth_associations, audit_logs, event_outbox).
```

That is a refusal, not a defect. Zero `_real` tables is ambiguous, and the two causes want
opposite answers: the scrub may simply not have run (the database is raw prod, every app-named
relation is already an ordinary writable table, and hydrating would be safe), or it may have run
and moved off `public` / renamed its suffix (the app names are read-only VIEWs, and promoting
those over a good local database is exactly the outcome the view-swap exists to prevent). A count
alone cannot separate them, so hydrate declines both.

Measured 2026-08-10: mirror RDS instance created 14:06 UTC,
`/mirror/current/postgres-rds/endpoint` updated 14:16, hydrate still refused at 14:22, succeeded
at 14:49. **Wait ~30 minutes and re-run.** To see where you are in the cycle:

```bash
aws ssm get-parameter --name /mirror/current/postgres-rds/endpoint \
  --profile dev_admin --query Parameter.LastModifiedDate --output text
```

`pii-scrubber-api-dev` is **not** the job that performs this scrub — it has been idle since
2026-04-28 and carries no EventBridge schedule. Its CloudWatch history is a dead end; do not
spend time there.

### Preview by default

Unlike `stack wipe` (prompt-by-default), hydrate is **preview**-by-default: a bare run prints
the full replacement map and exits 0 having made **no AWS call**, opened no tunnel, and
written no claim. `--execute` performs it; `--execute --yes` skips the prompt for agents/CI.

> Implementation note: BaseCommand's central claim-suppression keys on a flag named exactly
> `dry-run`, which hydrate does not have. `claimsSlot()` instead gates on an `--execute`
> latch captured from the raw argv in a `parse` override (the `stack wipe --slot all`
> precedent). The invariant preserved is "a preview never mutates `claim.json`", not the
> flag's spelling.

---

## Credential handling

The mirror master password is **never** written to a file, never logged, and never placed in
argv:

- it is fetched fresh from Secrets Manager on every run and held in memory only;
- transfer steps carry a **bare `-e PGPASSWORD`** (no `=value`), so docker copies it out of
  the spawning process's environment — `/proc/<pid>/environ` is same-user-only, whereas argv
  is world-readable in `ps`;
- `--no-password` is set on every mirror-side client, so a missing credential fails fast
  rather than hanging on a prompt;
- purely-local statements are *not* handed the secret at all.

This is why hydrate does **not** reuse the `EnvPsql` seam: `psqlArgs` puts the whole
`postgres://user:pw@host/db` connection string in argv, which is fine under local `trust`
auth and fatal for a real master password.

---

## Code layout

| file | role |
| --- | --- |
| `src/core/mirror/databases.ts` | the mirror→local map + selection resolution (pure) |
| `src/core/mirror/sql.ts` | every SQL statement hydrate can run (pure) |
| `src/core/mirror/plan.ts` | the planner: source description → exact argv + statements + rename plan (pure) |
| `src/runtime/hydrate.ts` | the executor seam: `exec(argv, {secret})` — the ONE docker spawn site |
| `src/commands/stack/hydrate.ts` | flags, guards, progress, reporting |

The split is what makes the risky part testable: the planner's output is asserted
byte-for-byte in `src/core/mirror/__tests__/plan.unit.test.ts` with no database, no
container, no tunnel and no credential anywhere, and the command is driven end-to-end
against fakes in `src/commands/stack/__tests__/hydrate.int.test.ts`.
