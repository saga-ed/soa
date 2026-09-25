# Plan — push-button canonical snapshot re-cut (`/cut-canonical <service>`)

**Status:** DRAFT 2026-06-19 — design + **chain PROVEN end-to-end by hand** (programs-api → test prefix);
workflow YAML not yet authored.

> ## ✅ Prove-run (2026-06-19) — the chain works; corrections to the design below
> Manually executed the full throwaway chain once for programs-api to a `program-hub-programs-canonical-test`
> prefix, then verified + tore down. Result: every step works. Key CORRECTIONS the design couldn't know:
> - **`cut-canonical` must run the seed ITSELF** — it cannot rely on `sandbox-deploy` to seed. The
>   `sandbox-deploy`/`_deploy-ecs-api.yml` **Seed job gates on `inputs.is-preview == true`** (and
>   `seed-profile == ''`); a sandbox dispatch has is-preview=false, so Seed is SKIPPED (DB comes up
>   migrated-but-empty: 26 tables, Program=0). So: deploy the identifier (sandbox-deploy with empty
>   seed-profile gives task-def + provisioned + migrated DB), THEN run `db:seed:run` explicitly via
>   `run-migrate-task.sh`.
> - **`run-migrate-task.sh` needs explicit SSM overrides for dev** (its defaults point at non-existent
>   `/program-hub/infra/dev/*` paths). Use what the real migrate job uses:
>   `CLUSTER_SSM_PATH=/dev/shared-arm/ecs-cluster-arn`,
>   `SG_SSM_PATH=/program-hub/<api>/infra/dev/sg-id`,
>   `CAPACITY_PROVIDER=dev-shared-ec2-cluster-arm-capacity-provider`. (`SUBNETS_SSM_PATH` default
>   `/shared/infra/dev/private-subnet-ids` is correct.) Tier: `saga-infra-dev` (ecs:RunTask + PassRole).
> - **The two "blockers" collapsed:** `canonseed` is just a normal preview identifier (the parameterized
>   SAM deploy creates the task-def); and the `PROGRAM_HUB_DEPLOY_ROLE_ARN` the previews assume already
>   writes `/preview/*` secrets (previews do it every run). No IAM PR needed if cut-canonical mirrors
>   that auth.
> - **The s3-cp-versioning glue WORKS** (the one net-new piece): list dest `profile-canonical-v{N}.sql`,
>   N+1, `s3 cp` dump → `-v{N}.sql`, write fresh sidecar (schemaRev from the snapshot, `takenFromDb`=the
>   real canonical name, `version`/`supersedes`, and **`seedIdsVersion` finally populated** from the
>   package version), then `s3 cp` → the `profile-canonical.sql` + `.meta.json` pointer LAST.
> - **Verified consumable:** the test canonical restored into a fresh pg18 container clean — Program=11,
>   `_prisma_migrations` head `20260605120000_add_pod_group`. The cloud-side seed wrote migration history
>   natively (the P3005 recurrence guard holds by construction).
> - Provisioned DB came up **pg15** because the default-bump PRs (program-hub #236 / rostering #590 /
>   soa #173) aren't merged yet; once merged, canonseed DBs provision pg18 (and pg16→pg18 restore is
>   already proven, so no transition gap).

**Status (original):** DRAFT 2026-06-19 (design for review; not yet built)
**Goal:** turn the (currently manual, ~15-step) canonical re-cut into a **single rote action** a
developer runs after extending a service's `@saga-ed/*-seed-ids` catalog, so the refreshed seed data
is reusable by every future sandbox.
**Origin:** distilled from the hand-executed re-cut of 2026-06-19 (see
`rebaseline-canonical-from-synthetic-dev.md` Outcome block). That run *is* the spec — minus the
one-time bootstrap noise that does not recur.

---

## What does NOT recur (shed from the manual run)

The manual re-cut was hard mostly because of first-time-migration accidents, none of which apply to
"a dev extended a seed-id":

- **pg18→pg15 strip / `*-sdvload` staging** — artifact of dumping from a local pg18 synthetic-dev mesh.
  A cloud-side seed runs at the sandbox's own pg version; no laptop dump, no strip.
- **Local-vs-fleet PII-key mismatch** — artifact of seeding locally then loading. A cloud seed task
  reads the dev-fleet PII keys from Secrets Manager natively; the mismatch cannot happen.
- **Backfill-to-`v1` before snapshot** — only needed because the pre-existing canonicals predated
  numbered versioning. They are all `v1+` now, so `snapshot_db` auto-increments the next version
  non-destructively on its own.

## The steady-state spine (≈3 rote steps)

For one `<service>` (e.g. `programs-api`):

1. **Seed a throwaway DB cloud-side** — clean `prisma migrate deploy` + `db:seed` (PII keys injected
   from Secrets Manager) against a freshly-provisioned `<service>-canonseed` DB.
2. **HARD-GATE verify** (blocking — see below) before any pointer moves.
3. **Snapshot + publish to the canonical prefix** as the next immutable version.

That is the "very simple rote process" the ask wants. Everything below is how to make those 3 steps
real and safe.

---

## Decisions (locked by the user 2026-06-19)

- **Trigger:** pure manual `workflow_dispatch` (and/or a `/cut-canonical <service>` Slack command).
  No CI auto-detection, no auto-cut-on-merge — a canonical re-cut is **fleet-wide** (every future
  sandbox restores it), so it stays an explicit human action. (Auto-cut-on-merge was explicitly
  rejected: a bad/incomplete seed would silently become every sandbox's baseline — cf. the iam-pii
  P3005 of 2026-06-19.)
- **DB model:** **throwaway DB per run** — provision `<service>-canonseed`, seed it, snapshot, tear it
  down. The long-lived `<service>-canonical` DB is never left in a half-seeded state.
- **Snapshot destination:** `saga-orch snapshot` has no destination override (it writes to
  `<serviceName>/profile-canonical.sql`). So the workflow snapshots the throwaway, then **`s3 cp`s the
  artifact into `<service>-canonical/`**, computing the next version number and **re-writing the
  sidecar in-workflow** (it must NOT carry the throwaway's provenance).

---

## The hard gate (non-negotiable — this is the bug we already hit)

A naive "seed → snapshot" re-creates the iam-pii P3005 fleet-wide: that dump shipped `user_pii` with
**no `_prisma_migrations`** because the local seed swallowed a migrate failure, and it silently became
`v2`. The verify step is therefore **blocking**, run against the seeded throwaway DB *before* the
`s3 cp` that advances the pointer. It asserts, at minimum:

- `_prisma_migrations` table exists **and** its latest row == repo HEAD migration for that package
  (this is why a clean cloud-side `migrate deploy` — not a restore-from-dump — is mandatory; it is
  what writes the history table in the first place).
- Expected core table row counts are non-zero and within sane bounds (per-service assertion table).
- For iam: `user_pii` row count > 0 (PII keys were actually present), `roles` table absent + `UserRole`
  enum present (current model), users/personas counts match.
- The dump that will be copied actually **contains the `_prisma_migrations` COPY block** (grep the
  artifact, not just the DB) — catches a pg_dump that omitted it.

If any assertion fails → abort, do not touch the canonical prefix, leave the throwaway for inspection.

---

## Build (mostly glue over existing primitives)

Known gaps from the 2026-06-19 Explore pass:

1. **No canonical-shaped task-def / identifier.** `run-migrate-task.sh` targets
   `${PROJECT}-${SERVICE}-${IDENTIFIER}`; there is no `canonseed` identifier. Smallest glue: a
   throwaway `identifier=canonseed` deploy (creates the task-def family + its
   `DatabaseUrlSecretArn` secret) so the existing migrate/seed script works unchanged. iam-api needs
   BOTH `DatabaseUrlSecretArn` + `PiiDatabaseUrlSecretArn` written.
2. **Orchestrator is OIDC-gated over HTTP.** All `provision`/`snapshot`/`teardown` calls must go via
   `aws lambda invoke` (i.e. `saga-orch`, which already does this) — never the ALB.
3. **PII crypto keys** must be injected into the iam seed task env from Secrets Manager
   (`rostering/dev/pii-dek`, `pii-hmac-key`, `pii-dek-version`) — else iam-pii seeds 0 rows and the
   gate (correctly) fails.
4. **The s3-cp-versioning glue** re-implements a slice of `snapshot_db`: list `<service>-canonical/`
   for existing `profile-canonical-v{N}.sql`, pick `N+1`, `cp` the throwaway dump →
   `profile-canonical-v{N+1}.sql`, write a fresh sidecar (`schemaRev` from the verify step,
   `takenFromDb=<service>-canonical`, `supersedes=N`, `seedIdsVersion` from the package version),
   then `cp` → the `profile-canonical.sql` pointer **last**. (Note: this is the one spot that bypasses
   `snapshot_db`'s native versioning. A future infra-compose `snapshot --dest <prefix>` override would
   eliminate it — deferred; not chosen now.)

### Workflow skeleton (`cut-canonical.yml`, `workflow_dispatch` input `service`)

```
inputs: service (programs-api | scheduling-api | sessions-api | iam-api | …)

1. resolve per-service config: repo, seed package, canonical prefix(es), pii? (iam only)
2. deploy throwaway identifier=canonseed (task-def + DB secret)         [run-migrate-task infra]
3. provision <service>-canonseed DB(s) via saga-orch                    [lambda invoke]
4. write canonseed DB conn into the throwaway secret(s) (incl. PII for iam)
5. ECS migrate task:  migrate deploy   (writes _prisma_migrations)
6. ECS seed task:     db:seed / db:seed:run  (PII keys injected)
7. HARD-GATE verify (assertions above) — abort on any failure
8. saga-orch snapshot <service>-canonseed --seed-profile canonical
9. s3-cp the versioned dump + fresh sidecar into <service>-canonical/   [compute vN+1, pointer last]
10. teardown throwaway DB + identifier stack + secret
11. (optional) prove-once: restore the new pointer into a throwaway sandbox DB, run migrate deploy,
    assert "No pending migrations to apply"
12. report: new version, counts, schemaRev, S3 paths
```

### Per-service config table (the only thing that varies)

| service | repo | seed cmd | canonical prefix(es) | PII? |
|---|---|---|---|---|
| programs-api | program-hub | `db:seed:run` | program-hub-programs-canonical | no |
| scheduling-api | program-hub | `db:seed:run` | program-hub-scheduling-canonical | no |
| sessions-api | program-hub | `db:seed:run` | program-hub-sessions-canonical | no |
| iam-api | rostering | iam-db `db:seed` | rostering-iam-canonical + rostering-iam-pii-canonical | **yes** |

(iam is the one multi-DB / PII case; the others are single-DB no-PII and share one shape.)

---

## Recurrence guard baked in

The hard gate's `_prisma_migrations` assertion is exactly what makes this safe to repeat: any service
whose local seed swallows a migrate failure would fail the gate instead of silently shipping a
history-less canonical. The cloud-side clean `migrate deploy` ensures the history is written natively,
so the iam-pii regression class cannot recur through this path.

## Open items before build

- Confirm the throwaway `canonseed` identifier deploy is cheap/clean to create + tear down per run
  (vs. a persistent canonseed identifier reused across runs).
- Pin the Secrets Manager `PutSecretValue` tier for writing the canonseed DB conn into the throwaway
  secret (flagged UNVERIFIED in the rebaseline runbook).
- Decide the trigger surface: a `cut-canonical.yml` `workflow_dispatch` is the MVP; a `/cut-canonical`
  Slack command (mirroring program-hub `db-commands.yml`) is the nicer UX on top.
- Sidecar `seedIdsVersion`: currently always null; this workflow is the natural place to finally
  populate it (audit trail of which seed-ids version a canonical was cut from).

---
*Design distilled 2026-06-19 from the hand-executed re-cut; decisions (manual trigger, throwaway DB,
s3-cp dest) locked by the user same day.*
