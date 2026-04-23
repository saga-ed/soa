# saga-mesh — shared infra for the SDS fixture mesh

Part of saga-ed/student-data-system#80 Phase 2. Composes postgres + redis + rabbitmq into one `saga-mesh` docker-compose project that provides shared infra for the rostering + program-hub + student-data-system trio.

## Usage

```bash
cd ~/dev/soa/infra

# First-time bring-up (seeds the six databases + owners):
SEED_PROFILE=empty make up PROJECT=saga-mesh

# Status:
SEED_PROFILE=empty make status PROJECT=saga-mesh

# Teardown:
SEED_PROFILE=empty make down PROJECT=saga-mesh

# Nuke volume + restart (fresh seed):
SEED_PROFILE=empty make reset PROJECT=saga-mesh
```

All apps connect to `localhost:5432` with their canonical credentials:

| App | DB | User | Password | Purpose |
|---|---|---|---|---|
| rostering iam-api | `iam_local` | `iam` | `iam` | IAM groups + users + memberships |
| rostering iam-pii | `iam_pii_local` | `iam_pii` | `iam_pii` | PII separation schema |
| program-hub programs-api | `programs` | `saga_user` | `password123` | Programs + enrollment |
| program-hub scheduling-api | `scheduling` | `saga_user` | `password123` | RRULE-expanded schedules |
| SDS ads-adm-api | `ads_adm_local` | `ads_adm` | `ads_adm` | Attendance records |
| SDS ledger-api | `ledger_local` | `ledger` | `ledger` | Ledger entries |

Dev mode uses `POSTGRES_HOST_AUTH_METHOD=trust` so passwords aren't validated — included for completeness.

## Adding new profiles

Future profiles (e.g., `demo-small`, `basic`) can be added as `seed/profile-<name>.sql` files in this directory. Each profile re-runs `CREATE DATABASE` + `CREATE USER` (safely — the postgres volume name is tied to the profile, so a new profile starts from an empty postgres instance) and then seeds whatever application data the profile calls for.

## Why the mesh goes here

Per the plan at `~/dev/sds-fixture/claude/projects/sds_80/phase-2/soa-infra-alignment.md`, this project replaces the per-repo `docker-compose.yml` postgres containers that the three sibling repos previously ran. Each sibling repo's base compose now gates its own postgres behind a `standalone` profile — when the mesh is up, those containers stay down.
