# Plan — re-baseline the dev `canonical` seed snapshots to current-main synthetic-dev state

> ## ✅ Outcome (EXECUTED 2026-06-19)
> All 5 dev `canonical` snapshots were re-cut from current-main synthetic-dev data and verified
> end-to-end. The execution diverged from (and simplified) the plan below — record of what actually
> happened:
> - **Simpler path than the "throwaway-identifier + ECS migrate/seed" Option A:** Goal 1 had already
>   produced validated, pg-stripped, dev-fleet-PII-key dumps staged at
>   `s3://saga-db-seeds-dev/<svc>-sdvload/profile-syntheticdev.sql`. So the re-cut was: provision/reuse
>   the canonical-named DB → `saga-orch raw restore` (seedFrom=`<svc>-sdvload`) → SSM-verify counts →
>   `saga-orch snapshot --seed-profile canonical`. No ECS migrate/seed tasks, no Secrets Manager
>   retarget needed.
> - **Numbered versioning (soa#168, infra-compose 1.5.0) was deployed FIRST** so snapshots are
>   non-destructive: backfilled each existing `profile-canonical.sql` → `-v1` BEFORE snapshotting, so
>   the re-cut landed as `-v2` (+ pointer). Fleet upgraded to 1.5.0 in place via SSM `npm install -g`
>   (no instance refresh — preserved per-sandbox EBS).
> - **Results:** rostering-iam → v2 (users 218, personas 28, roles-table dropped / UserRole enum);
>   rostering-iam-pii → v2 (user_pii 28, dev-fleet keys); program-hub-programs → v2; program-hub-scheduling
>   → v2; **program-hub-sessions → v1 (NEW prefix — the gap is closed)**. Consumer wiring: program-hub
>   PR #230 added the `sessions-api` seedFrom case arm.
> - **pg15 compat:** `\restrict` in pg16 dumps is NOT fatal via the `psql -f` restore path (proven);
>   the Goal-1 killer was `SET transaction_timeout` (pg17+ only, absent in pg16). No strip needed.
> - **Verified end-to-end** by composing a fresh sandbox (`canon-check-0619`) on `canonical`: dash
>   rendered synthetic-dev data (Sessions list, Rosters 6/3/4, Demo District).
> - **⚠ RECURRENCE — iam-pii migration history:** the first iam-pii re-cut (v2) dropped the
>   `_prisma_migrations` table because its `*-sdvload` source dump came from a LOCAL synthetic-dev iam-pii
>   whose own `prisma migrate deploy` had P3005'd and never wrote history. A fresh sandbox then hit P3005
>   on iam-pii deploy. Fixed by restoring the migration-history row (canonical → v3). **Any future iam-pii
>   canonical re-cut MUST run a clean local `migrate deploy` first (so `_prisma_migrations` is written)
>   before the dump, or it regresses the same way.** This applies to any service whose local seed swallows
>   a migrate failure — verify the source dump contains `_prisma_migrations` before snapshotting.

**Status:** DONE 2026-06-19 (was DRAFT 2026-06-18 — see Outcome block above for how execution differed)
**Scope:** the dev `canonical` profile snapshots in `s3://saga-db-seeds-dev/*-canonical/`.
**Why now:** the current canonical is ~7 iam migrations behind `origin/main`; the blocker is
rostering `20260609170418_replace_roles_table_with_user_role_enum` (#419 — drops the `roles`
table, role becomes a `UserRole` enum). Restoring the stale canonical onto current-main iam-api
risks the schema-versioning destructive-gate. This is the "compatible versions" fix the user named.
**Sibling:** `trueup-latest-main-sandbox-to-synthetic-dev.md` (the consumer); `up-sh-db-seed-transition.md`
(the local-side db:seed convergence this mirrors in-cloud).

## Goal & success criterion

Re-cut each service's `canonical` S3 snapshot from a DB **migrated to current `origin/main`
schema and seeded by the same `db:seed` synthetic-dev uses** — so a sandbox composed on `canonical`
holds the new role model + synthetic-dev's full-seed data. Parity holds **by construction**: the
deployed `db:seed:run`/`db:seed` is the same seed binary at the same `main` commit as local
synthetic-dev's `pnpm db:seed`, both rooted in `seed-ids`.

**Acceptance per chain (diff the new snapshot before pointing latest-main at it):**
- iam: NO `roles` table; `UserRole` enum present; personas carry `role` inline; **205 users**;
  **6 admin personas** (#397) — not the old 2; deterministic dev id present.
- iam-pii: **user_pii ≈ 15** (NOT empty — see the PII crypto-key requirement below).
- programs: Program 10 / TutoringPeriod 24 / Pod 8 etc.; scheduling: Schedule 9 / RecurrenceRule 17.

## How seeding/snapshotting actually works (verified `origin/main`, 2026-06-18)

- **S3 prefix == serviceName.** Snapshot has no destination override: `s3://saga-db-seeds-dev/<serviceName>/profile-<profile>.sql` (`soa: infra/src/ec2/profiles.js:92`) + a `profile-<profile>.meta.json` schemaRev sidecar (`:136-142`). To land at `program-hub-programs-canonical/profile-canonical.sql` you MUST snapshot a DB whose **registered serviceName is literally `program-hub-programs-canonical`**, with `--seed-profile canonical`.
- **Snapshot/pg_dump runs ON the db-host EC2** under its `InstanceRole` `S3SeedData` policy (`iac: cloudformation_templates/dbs/db_host_v2/iam/template.yaml:56-67`). So **no human S3-write tier is needed** — provision/snapshot/restore are host-role-mediated.
- **`saga-orch`** (`iac: saga-platform/.../orchestrator/cli.py`) verbs: `provision`/`describe`/`snapshot`/`restore`/`reset`/`teardown`/`list`. CI uses `saga-orch raw --payload` = direct `aws lambda invoke`.
- **No automated "cut canonical" workflow exists** in any repo — the `*-canonical` prefixes appear only as `seedFrom` read-sources. This runbook IS the manual procedure (the by-hand form of the absent "Flow B" / re-snapshot-canonical automation; automate once proven).

## ⚠ THE off-paved step — DB connection targeting

`run-migrate-task.sh` (`program-hub: .github/scripts/run-migrate-task.sh`) launches a one-off ECS
task against family `FAMILY=<project>-<service>-<identifier>` and overrides **only the container
`command`**. The DB connection is **injected via Secrets Manager `ValueFrom`** (`DatabaseUrlSecretArn`
→ `DATABASE_URL`, `PiiDatabaseUrlSecretArn` → `PII_DATABASE_URL`; `program-hub: infra/programs-api/service-template.yaml:262-271`,
rostering equivalently). **There is no canonical-shaped task-def**, so the migrate/seed task can't
target a canonical scratch DB out of the box.

**Resolution (use the throwaway-identifier path; do NOT repoint a live service's secret):**
1. Deploy a **dedicated throwaway identifier** stack (e.g. `identifier=canonseed`) for the service —
   this creates a task-def family `<project>-<service>-canonseed` and its `DatabaseUrlSecretArn`
   secret (`/preview/<api>/canonseed/database-url`).
2. Write the **canonical scratch DB's** connection into that secret (`secretsmanager:PutSecretValue`):
   `postgresql://postgres_admin:password123@<PRIVATE_IP>:<PORT>/<db_name>?schema=public`.
   **Use the instance PRIVATE IP from `saga-orch describe`, not the CloudMap `<name>.dbs-v2.local`** —
   one-off tasks often can't resolve CloudMap → Prisma `P1001`.
3. Run migrate + seed against `identifier=canonseed` (the task reads the retargeted secret).
4. Snapshot the **canonical-named** DB (separate `saga-orch` call — see chains).
5. Tear down the throwaway identifier stack + its secret.

> **NEVER** repoint an existing live/serving identifier's secret at the canonical DB — it silently
> redirects a running service and is trivially forgotten un-reverted.

**Alternative — "migrate an existing sandbox, then `s3 cp` the snapshot" (least work IF a current-main
sandbox PR is already open per service).** The migrate/seed half is *cleaner* here: an existing
`<api>-pr-NN` sandbox already has a task-def whose secret points at its own DB, so you migrate+seed it
with NO secret rewrite. BUT snapshot has no destination override — `saga-orch snapshot --service-name
<api>-pr-NN` lands at `<api>-pr-NN/profile-canonical.sql`, which previews (`seedFrom=...-canonical`)
never read (`seedFrom` overrides the *read* source only; there is no symmetric write override). The
only rescue is an **out-of-band `aws s3 cp`** of `<api>-pr-NN/profile-canonical.{sql,meta.json}` →
`<...>-canonical/profile-canonical.{sql,meta.json}`. Tradeoffs: ✅ no provision, no secret-write;
❌ off the orchestrator path (no DDB registry row, no profile-registry update), and the **copied
`.meta.json` schemaRev is NOT recomputed** — the destructive-migration detector reads that sidecar,
so a stale/mismatched schemaRev after a manual cp can mis-fire. Acceptable for a one-time re-baseline,
not as a habit. Needs `s3:GetObject`+`PutObject` on the seed bucket directly. **Prefer Option A**
(provision the canonical-named DB so the snapshot lands natively + the sidecar is freshly computed);
fall back to this only if a clean current-main sandbox already exists and provisioning is undesirable.

## AWS tiers

| Step | Tier | Evidence |
|---|---|---|
| `saga-orch` provision/describe/snapshot/restore (lambda:InvokeFunction) | **saga-runtime-dev** | `iac: app_runtime_permission_set/template.yaml:88-94` |
| migrate/seed one-off ECS task (`ecs:RunTask` + `iam:PassRole`) | **saga-infra-dev** | `app_infra_permission_set/template.yaml:104-107` + `saga_cap_iam_pass_role_saga_services` |
| SSM read in run-migrate-task.sh | saga-runtime-dev | `saga_cap_app_runtime_read` (all tiers) |
| Secrets Manager `PutSecretValue` on `/preview/*` (the retarget) | **UNVERIFIED — pin before executing** | preview path uses the deploy role, not a tiered profile |
| S3 PutObject (snapshot upload) | **none — host-role-mediated** | db-host `InstanceRole` `S3SeedData` |

Announce + confirm before elevating; no step requires admin.

## The four chains (sessions is a fifth, see below)

### Order (load-bearing)
**iam + iam-pii FIRST**, then programs/scheduling/sessions — the programs/sessions `db:seed` call a
live, seeded iam-api (`program-hub: scripts/reset-and-reseed.sh` seeds IAM, starts iam-api, then
seeds programs with `IAM_API_URL`). Cut iam canonical and have a reachable seeded iam-api up first.

### Chain A — iam (TWO DBs, one combined migrate/seed task)
```bash
saga-orch provision --service-name rostering-iam-canonical     --engine postgres --engine-version 15 --db-name iam_canonical
saga-orch provision --service-name rostering-iam-pii-canonical --engine postgres --engine-version 15 --db-name iam_pii_canonical
saga-orch describe  --service-name rostering-iam-canonical       # PRIVATE IP:port → DATABASE_URL
saga-orch describe  --service-name rostering-iam-pii-canonical   # PRIVATE IP:port → PII_DATABASE_URL
# Off-paved: write BOTH secrets (DatabaseUrlSecretArn + PiiDatabaseUrlSecretArn) on the throwaway iam identifier.

# Combined migrate + seed (one task, both DBs):
PROJECT=rostering SERVICE=iam-api IDENTIFIER=canonseed ENV=dev CONTAINER=iam-api \
  COMMAND='["sh","-c","pnpm --filter @saga-ed/iam-db db:deploy && pnpm --filter @saga-ed/iam-pii-db db:deploy && pnpm --filter @saga-ed/iam-db db:seed"]' \
  ./.github/scripts/run-migrate-task.sh

saga-orch snapshot --service-name rostering-iam-canonical     --seed-profile canonical
saga-orch snapshot --service-name rostering-iam-pii-canonical --seed-profile canonical
```

> **⚠ CRITICAL — iam-pii is NOT schema-only; do not let it come out empty.** iam-db's `db:seed`
> DOES write the ~15 `user_pii` rows, but `prisma/seed.ts:52-58` **silently skips PII unless the
> PII crypto keys are present in the task env**: `PII_DATABASE_URL` PLUS
> `PII_DEK_HEX`+`PII_HMAC_KEY_HEX` (local-dev names) OR `PII_CRYPTO_PIIDEKHEX`+`PII_CRYPTO_PIIHMACKEYHEX`
> (runtime names). The deployed iam-api task already has the runtime crypto config; **verify those
> env/secret values are present on the `canonseed` task** before running seed, or the new
> `rostering-iam-pii-canonical` regresses today's 15 rows to 0 and breaks email-keyed login in every
> future sandbox. Acceptance: `user_pii ≈ 15`, NOT empty.

### Chain B — programs (single DB)
```bash
saga-orch provision --service-name program-hub-programs-canonical --engine postgres --engine-version 15 --db-name programs_api_canonical
saga-orch describe  --service-name program-hub-programs-canonical    # PRIVATE IP:port
# Off-paved: write the programs throwaway identifier's DatabaseUrlSecretArn at this DB.
PROJECT=program-hub SERVICE=programs-api IDENTIFIER=canonseed ENV=dev CONTAINER=programs-api \
  COMMAND='["npm","run","db:deploy"]'   ./.github/scripts/run-migrate-task.sh
PROJECT=program-hub SERVICE=programs-api IDENTIFIER=canonseed ENV=dev CONTAINER=programs-api \
  COMMAND='["npm","run","db:seed:run"]' ./.github/scripts/run-migrate-task.sh
saga-orch snapshot --service-name program-hub-programs-canonical --seed-profile canonical
```

### Chain C — scheduling
Same shape as B with `SERVICE=scheduling-api`, `--service-name program-hub-scheduling-canonical`,
`--db-name scheduling_api_canonical`.

### Chain D / fifth — sessions (NEW prefix — needs a code change too)
sessions-api has the db scripts (`db:deploy`, `db:seed:run`) but **no canonical prefix and is
absent from the seedFrom case statement**. Beyond cutting the snapshot:
- Provision `program-hub-sessions-canonical`, migrate + `db:seed:run`, snapshot `--seed-profile canonical`.
- **Code change:** add a `sessions-api) SF=program-hub-sessions-canonical ;;` arm to
  `program-hub: .github/workflows/_deploy-ecs-api.yml` seedFrom case (PR) so composes can `seedFrom` it.

## Per-service migrate/seed commands (verified)

| Service | migrate | seed | note |
|---|---|---|---|
| programs/scheduling/sessions | `npm run db:deploy` | `npm run db:seed:run` (= `node dist/seed/seed.js`) | bundled in runtime image `dist/seed/seed.js` |
| iam-db | `pnpm --filter @saga-ed/iam-db db:deploy` | `pnpm --filter @saga-ed/iam-db db:seed` | writes iam + (with crypto keys) PII |
| iam-pii-db | `pnpm --filter @saga-ed/iam-pii-db db:deploy` | none (PII written by iam-db's seed) | schema applied here; data from iam-db seed |

## Safety gates (execute as steps, not prose)
1. **Back up** each existing `profile-canonical.sql` + `.meta.json` to a dated key
   (`aws s3 cp ... s3://saga-db-seeds-dev/<prefix>/backup-2026-06-18/`) BEFORE any overwrite.
   Confirm whether the bucket has versioning; if not, the backup is the only rollback.
2. **Pin the Secrets Manager write tier** (the retarget needs `PutSecretValue`) — currently UNVERIFIED.
3. **Prove once against a throwaway prefix** (e.g. `program-hub-programs-canonical-test`) → restore
   into a sandbox → confirm role model + counts → THEN overwrite the real canonical.
4. **Explicit user go-ahead before the first real canonical overwrite** (fleet-wide blast radius:
   every future dev sandbox restores this).
5. After each re-cut, **diff vs acceptance** (above) before pointing latest-main at it.

## Then: recompose latest-main against fresh canonical
Once canonical is re-cut + validated, recompose `latest-main` (resetAllData=canonical) per
`trueup-latest-main-sandbox-to-synthetic-dev.md`. NOTE iam-api rides a separate rostering deploy
track and was not in the last recompose — ensure its sandbox variant restores the new
`rostering-iam-canonical` too.

---
*Mechanics verified against origin/main 2026-06-18 (iac/program-hub/rostering/soa); iam-pii crypto-key
requirement confirmed in rostering iam-db/prisma/seed.ts:44-58.*
