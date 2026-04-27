# Instance vs. database

A short design note on how `infra-compose` handles (and doesn't handle) the distinction between a **database instance** and a **database**.

## The distinction

- **Database instance** — a running database server (process + data volume + host+port). One postgres instance can host many databases.
- **Database** — a logical grouping of schemas/tables inside an instance.

## What infra-compose does

By design, infra-compose packages **one instance per service type** (one postgres, one mysql, one mongo, one redis, one rabbitmq) per project. Within that one instance you can host many databases via an `EXTRA_POSTGRES_SEED_DIR`-provided init script (see `projects/saga-mesh/seed/profile-empty.sql` for an example creating six databases).

This means a project like `saga-mesh` runs six logical databases on one postgres instance:

- `iam_local`, `iam_pii_local` (rostering)
- `programs`, `scheduling` (program-hub)
- `ads_adm_local`, `ledger_local` (student-data-system)

All six share CPU, memory, disk IOPS, and the same postgres version in dev.

## What infra-compose does NOT do

**It does not model multiple instances of the same service type within one project.** If you want two postgres instances — say, one tuned for high-IOPS workloads and one for low-churn audit data — infra-compose today has no first-class affordance. Your options would be:

1. **Duplicate the service fragment** — copy `services/postgres/compose.yml` to `services/postgres-tier2/compose.yml`, maintain both.
2. **Inline services in the project file** — declare the second postgres directly in `projects/<name>.yml` instead of `include:`-ing.
3. **Don't.** (Recommended — see below.)

## Why this is usually fine

**In production, apps connect via `DATABASE_URL` — a string that's instance-agnostic from the app's perspective.** The same `ads_adm_local` database can live on:

- `postgresql://ads_adm@localhost:5432/ads_adm_local` (dev — shared instance, via this repo)
- `postgresql://ads_adm@ads-adm-prod-primary.rds.amazonaws.com:5432/ads_adm_local` (prod — dedicated instance on high-IOPS hardware)
- `postgresql://ads_adm@shared-small-cluster:5432/iam_pii_local` (prod — low-load audit data on lean hardware)

The app doesn't know or care. Instance tiering is a **deployment-config concern** — lives in Terraform / CDK / per-env env vars — not an infra-compose concern.

**infra-compose is a dev tool.** Its job is to give you a one-command local environment. The right trade-off is one-instance-many-DBs: fewer processes to watch, one volume to snapshot for fixture work, one place to `psql` into when something's weird. Forcing dev topology to match prod topology makes the dev loop strictly worse without improving anything.

## When to revisit

If a real workload proves it needs multiple instances in dev, revisit this doc. Plausible triggers:

- A service performs a fixture-level load test and needs an isolated postgres so it doesn't contend with other apps' dev traffic.
- An app requires a postgres version that conflicts with another app's.
- A service needs postgres extensions (e.g. `pg_cron`, `citus`) that another service doesn't want polluting its instance.

When that happens, pick one of the two options above (duplicate the fragment, or inline in the project). We'll know what shape the problem wants at that point; speculating earlier would just add machinery nobody uses.

## For this repo's consumers

**If your project ships many databases:** put them all in one postgres via an init script in your project's `EXTRA_POSTGRES_SEED_DIR`. See `projects/saga-mesh/seed/profile-empty.sql` for the canonical pattern.

**If your project needs multiple instances of the same service:** talk to infra maintainers first. The answer is probably "inline in the project file" or "file an issue to add a tiered variant to `services/`."

**Prod topology:** not our concern here. Keep `DATABASE_URL`s configurable per env.

---

*Context: drafted 2026-04-23 while setting up the `saga-mesh` project for saga-ed/student-data-system#80 Phase 2. The framing emerged from the question: "how does infra-compose let us run high-load DBs on better hardware than low-load ones?"*
