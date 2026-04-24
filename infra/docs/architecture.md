# Architecture

The mental model behind volume-per-profile switching, sentinel seeding, and the three-layer design.

## Volume-per-profile isolation

Each data service's `compose.yml` names its volume with the profile baked in:

```yaml
# compose/services/mongo/compose.yml (abbreviated)
services:
  mongo:
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:
    name: mongo-profile-${SEED_PROFILE:-small}
```

Docker Compose does variable substitution on the `name:` field, so starting with `SEED_PROFILE=basic` attaches a volume literally called `mongo-profile-basic`. Starting with `SEED_PROFILE=small` attaches `mongo-profile-small` — a *different* volume. No data is shared between profiles.

Switching is a two-step sequence:

```
  ┌──────────────────────────┐
  │ docker compose down      │     containers stopped, volumes persist
  │ SEED_PROFILE=basic       │
  │ docker compose up -d     │     new containers attach mongo-profile-basic
  └──────────────────────────┘
```

Total time:
- ~3–5s if `mongo-profile-basic` already exists and is seeded
- +10–30s for the first seed (init container populates data)

## Sentinel-based idempotent seeding

Every data service ships with an `*_init` sidecar that runs once at boot:

```
  ┌──────────────────────────────┐
  │ wait for service healthcheck │
  └───────────────┬──────────────┘
                  │
  ┌───────────────▼──────────────┐
  │ connect to DB                │
  │ check for _profile_meta      │
  │   (collection in Mongo,      │
  │    table in SQL)             │
  └───────────────┬──────────────┘
                  │
          ┌───────┴───────┐
          │               │
    found?│               │not found
          │               │
  ┌───────▼──────┐  ┌─────▼──────────────────┐
  │ exit 0       │  │ load profile-$N.json   │
  │ (idempotent) │  │ or profile-$N.sql      │
  └──────────────┘  │ write _profile_meta    │
                    │ exit 0                 │
                    └────────────────────────┘
```

This means:
- First `up` after `docker volume create` → seeding happens (~10–30s depending on size)
- Second `up` on the same volume → skipped, boot is fast
- `docker volume rm mongo-profile-basic` forces reseed on next up
- `make reset PROFILE=basic` = volume rm + up (full reseed)

Seed files live in `compose/services/<service>/seed/profile-<name>.{json,sql}`. Custom project seeds can be layered on via the `--seed-dir` option (see [adoption-guide.md](./adoption-guide.md#providing-custom-seed-data)).

## Three-layer API design

```
  ┌─────────────────────────────────────────────────┐
  │ Transport                                       │
  │   bin/infra-compose   (CLI — bash)              │
  │   src/router.js       (Express, /infra/*)       │
  └──────────────────┬──────────────────────────────┘
                     │ route → handler
  ┌──────────────────▼──────────────────────────────┐
  │ Handlers  (src/handlers.js)                     │
  │   - profile name regex validation               │
  │   - sanitize output_dir / data_dir / seed_dir   │
  │   - uniform { ok: true, … } / { ok: false, … }  │
  └──────────────────┬──────────────────────────────┘
                     │ call API with validated opts
  ┌──────────────────▼──────────────────────────────┐
  │ API  (src/api.js)                               │
  │   - up / switch_profile / reset / restore       │
  │   - snapshot (direct DB dump via mongo+mysql2)  │
  │   - list_profiles / get_active_profile          │
  │   - spawn docker compose with -f + cwd          │
  │   - maintain ~/.fixtures/active-profile         │
  └─────────────────────────────────────────────────┘
```

The same API layer serves both the CLI and the HTTP router — they're just two transports over identical logic. fixture-serve consumes the HTTP router; the CLI consumes the API directly.

## `compose_file` threading

All lifecycle functions accept a `compose_file` option so a single fixture-serve instance can target a project-specific compose rather than the bundled master `compose/compose.yml`:

```
  POST /infra/switch  {profile: "basic"}
         │
         ▼
  create_router({ compose_file: "/etc/saga-api.yml", … })
         │  merges compose_file into the handler input
         ▼
  handle_switch({ profile: "basic", compose_file: "/etc/saga-api.yml" })
         │
         ▼
  switch_profile({ profile: "basic", compose_file: "/etc/saga-api.yml" })
         │
         ▼
  docker compose -f /etc/saga-api.yml down
  docker compose -f /etc/saga-api.yml up -d
```

Without threading, the HTTP layer would have sent the profile change to the bundled master compose instead of the caller's project file, and containers would come up in the wrong project.

When `compose_file` is absent, `api.js` runs `docker compose` from the `compose/` subdirectory so the bundled master `compose.yml` is the default.

## Env file precedence

Both `api.js` and `bin/infra-compose` load three env files in this order, with later values overriding earlier:

| Order | File | Purpose |
|---|---|---|
| 1 | `$PKG_ROOT/.env.defaults` | Bundled, wiped by `npm install -g` — ship your canonical ports here |
| 2 | `$PKG_ROOT/.env` | Project-local, gitignored — per-checkout overrides |
| 3 | `~/.fixtures/.env` | User-level — **survives `npm install -g` reinstalls** |

The user-level file is the right place to persist things like a non-default `MONGO_PORT` across package upgrades.

## Active profile state

`~/.fixtures/active-profile` is a JSON file written by every mutating function:

```json
{"profile":"basic","switched_at":"2026-04-24T10:15:00Z"}
```

- Written by: `up`, `switch_profile`, `reset`, `restore`
- Read by: `get_active_profile()` (exported), `make status`, `/infra/active-profile`, fixture-serve's `/health`
- Legacy format: a single line with just the profile name (no `switched_at`) is still parsed for backward compatibility

## Snapshot / restore data flow

```
  snapshot({ profile: "scenario-1", services: ["mongo","mysql"] })
         │
         ├── mongo: connect, iterate non-system DBs,
         │          dump docs as EJSON
         │          → ~/.fixtures/profiles/mongo/profile-scenario-1.json
         │             (with _meta: {type: "snapshot", dumped_at, …})
         │
         └── mysql: connect, iterate user DBs,
                    emit CREATE + INSERT statements
                    → ~/.fixtures/profiles/mysql/profile-scenario-1.sql
                       (header comment: -- @infra-compose/snapshot)

  restore({ profile: "scenario-1" })
         │
         ├── if volumes `mongo-profile-scenario-1` / `mysql-profile-scenario-1` exist:
         │      down → volume rm → up with SEED_PROFILE=scenario-1
         │      init containers load profile files from user data dir
         │
         └── if volumes don't exist:
                up with SEED_PROFILE=scenario-1 (first-time seed)
```

Postgres snapshot is **not implemented in JS** — the CLI `dump` command handles it via `pg_dump`. Snapshotting a stack that includes postgres via the programmatic `snapshot()` skips postgres silently; use the CLI for full round-trips involving postgres.

## Port-offset convention

To avoid collisions with system DBs and VPN IP ranges, infra-compose uses **non-standard ports** everywhere:

| Service | Standard | infra-compose | Why |
|---|---|---|---|
| MongoDB | 27017 | **27018** | System mongod often uses 27017 |
| MySQL | 3306 | **3307** | System mysqld often uses 3306 |
| PostgreSQL | 5432 | **5433** | Brew/system Postgres often uses 5432 |
| Redis | 6379 | **6380** | Local Redis installs use 6379 |

Change via `.env` or `~/.fixtures/.env` if needed — but be aware that `/etc/docker/daemon.json` may also need `"default-address-pools"` configured to avoid routing collisions with corporate VPNs. See [troubleshooting.md](./troubleshooting.md).
