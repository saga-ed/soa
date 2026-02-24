# Composable Docker Services with Profile Switching

Compose the database services each project needs, with instant switching between
pre-seeded data profiles using volume-per-profile isolation.

## How It Works

1. **Services** (`services/`) — each database is a standalone compose file
2. **Projects** (`projects/`) — compose files that `include:` the services they need
3. **Profiles** — each seed profile gets its own Docker volume (e.g., `mongo-profile-small`)
4. Switching profiles means detaching one volume and attaching another — instant if already seeded

```
┌─────────────────────────────────────────────────────────┐
│  projects/saga-api.yml                                  │
│    include:                                             │
│      - services/mongo/compose.yml                       │
│      - services/mysql/compose.yml                       │
└─────────┬───────────────────────────────┬───────────────┘
          │                               │
  ┌───────▼────────┐             ┌────────▼───────┐
  │     mongo      │             │     mysql      │
  │  :27018        │             │  :3307         │
  └───────┬────────┘             └────────┬───────┘
          │                               │
  ┌───────▼────────┐             ┌────────▼───────┐
  │ Volume:        │             │ Volume:        │
  │ mongo-profile- │             │ mysql-profile- │
  │   small        │             │   small        │
  │   basic        │             │   basic        │
  └────────────────┘             └────────────────┘
```

## Quick Start

```bash
cd infra

# Start saga-api services (mongo + mysql) with default profile
make up PROJECT=saga-api

# Switch to basic profile (first time: seeds data; then: instant)
make switch PROJECT=saga-api PROFILE=basic

# Start adm-api services (postgres + redis)
make down PROJECT=saga-api
make up PROJECT=adm-api

# Start events example (rabbitmq + postgres)
make down PROJECT=adm-api
make up PROJECT=events-example
```

## Projects

| Project | Services | Use Case |
|---------|----------|----------|
| `saga-api` | mongo, mysql | Main GraphQL/REST API |
| `adm-api` | postgres, redis | Attendance & Daily Management API |
| `events-example` | rabbitmq, postgres | Event-driven example |

## Services

| Service | Port | Profile Switching | Volume Pattern |
|---------|------|-------------------|----------------|
| MongoDB | 27018 | Yes | `mongo-profile-<name>` |
| MySQL | 3307 | Yes | `mysql-profile-<name>` |
| PostgreSQL | 5433 | Yes | `postgres-profile-<name>` |
| Redis | 6380 | No | `redis-data` |
| RabbitMQ | 5673 / 15673 | No | `rabbitmq-data` |

## Profile Switching

Profiles are isolated Docker volumes. Switching detaches one volume and attaches another:

```bash
# Switch — instant if profile was previously seeded
make switch PROJECT=saga-api PROFILE=basic

# Reset one profile (wipe volume + re-seed) — other profiles untouched
make reset PROJECT=saga-api PROFILE=basic

# See what volumes exist
make volumes
```

### How seeding works

Each data service has a seeder (`*_init` container) that:
1. Waits for the service to be healthy
2. Checks for a sentinel (doc/table) marking "already seeded"
3. If absent, loads `seed/profile-<name>.json|sql`
4. Writes the sentinel so subsequent starts skip seeding

## Make Targets

| Target | Description |
|--------|-------------|
| `make up` | Start project services |
| `make switch` | Switch to a different profile |
| `make down` | Stop services (keep volumes) |
| `make reset` | Wipe + re-seed one profile |
| `make check-ports` | Pre-flight port conflict check (runs automatically before `up`) |
| `make status` | Show running containers and volumes (all projects) |
| `make logs` | Tail container logs |
| `make volumes` | List all profile volumes |
| `make list-projects` | Show available projects and their services |
| `make list-profiles` | Show available seed profiles per service |
| `make mongo-shell` | Open mongosh |
| `make mysql-shell` | Open mysql client |
| `make psql-shell` | Open psql |
| `make redis-cli` | Open redis-cli |
| `make clean-all` | Destroy ALL data |
| `make help` | Show all targets |

All targets accept `PROJECT=<name>` and `PROFILE=<name>` (defaults: saga-api, small).

## Adding a New Service

1. Create `services/<name>/compose.yml` with the service definition
2. For profile switching: add a `seed/` dir with init script and profile data files
3. Use `name: <name>-profile-${SEED_PROFILE:-small}` in the volume definition
4. Add the service to project files that need it

## Adding a New Project

1. Create `projects/<name>.yml`:

```yaml
include:
  - path: ../services/mongo/compose.yml
  - path: ../services/redis/compose.yml
```

2. That's it. `make up PROJECT=<name>` just works.

## Adding a New Profile

1. Add seed data files in the appropriate service directories:
   - Mongo: `services/mongo/seed/profile-<name>.json`
   - MySQL: `services/mysql/seed/profile-<name>.sql`
   - Postgres: `services/postgres/seed/profile-<name>.sql`

2. Switch to it: `make switch PROJECT=saga-api PROFILE=<name>`

## Directory Structure

```
infra/
├── services/
│   ├── mongo/
│   │   ├── compose.yml
│   │   └── seed/
│   │       ├── init-and-seed.js
│   │       ├── profile-small.json
│   │       └── profile-basic.json
│   ├── mysql/
│   │   ├── compose.yml
│   │   └── seed/
│   │       ├── init-and-seed.sh
│   │       ├── profile-small.sql
│   │       └── profile-basic.sql
│   ├── postgres/
│   │   ├── compose.yml
│   │   └── seed/
│   │       ├── init-and-seed.sh
│   │       ├── profile-small.sql
│   │       └── profile-basic.sql
│   ├── redis/
│   │   └── compose.yml
│   └── rabbitmq/
│       └── compose.yml
├── projects/
│   ├── saga-api.yml           # mongo + mysql
│   ├── adm-api.yml            # postgres + redis
│   └── events-example.yml     # rabbitmq + postgres
├── .env.defaults
├── Makefile
└── README.md
```

## Ports

All ports are offset from defaults to avoid conflict with `local-db-mgr.sh`:

| Service | Default | Override |
|---------|---------|----------|
| Mongo | 27018 | `MONGO_PORT` |
| MySQL | 3307 | `MYSQL_PORT` |
| Postgres | 5433 | `POSTGRES_PORT` |
| Redis | 6380 | `REDIS_PORT` |
| RabbitMQ | 5673 / 15673 | `RABBITMQ_PORT` / `RABBITMQ_MGMT_PORT` |

Override in `.env` or inline: `make up PROJECT=saga-api MONGO_PORT=27020`

## Network Safety

Docker auto-assigns bridge subnets from `172.17.0.0/12`, which can overlap
corporate VPN ranges (commonly `172.20.*`, `172.21.*`). The Docker daemon is
configured to confine bridge networks to non-conflicting ranges:

```jsonc
// /etc/docker/daemon.json
{
    "default-address-pools": [
        { "base": "172.24.0.0/13", "size": 24 },
        { "base": "192.168.192.0/20", "size": 24 }
    ]
}
```

After editing `daemon.json`, restart the daemon:

```bash
sudo systemctl restart docker
```

## Port Conflict Detection

`make up` runs an automatic pre-flight check (`check-ports`) before starting
any services. If a required port is already in use by another Docker container,
it fails fast with actionable suggestions:

```
  ERROR: Port conflict detected!
  Port 5433 is in use by container 'soa-postgres-1' (project: soa)

  Option 1 — stop just the conflicting container(s):
    docker stop soa-postgres-1

  Option 2 — stop the entire project (all its services):
    docker compose -p soa down
```

This prevents confusing startup failures when switching between projects that
share database ports.

## Upgrading to 0.5.0 (PostgreSQL 18)

Version 0.5.0 upgrades PostgreSQL from 16 to 18, which changes the data directory layout.
**Existing postgres volumes must be removed** before starting services — PG18 will refuse to
start if it finds data in the old layout.

### What changed

| | Before (≤ 0.4.0) | After (0.5.0+) |
|---|---|---|
| Postgres image | `postgres:16` | `postgres:18` |
| Volume mount | `/var/lib/postgresql/data` | `/var/lib/postgresql` |

PG18 stores data in a major-version-specific subdirectory (`/var/lib/postgresql/18/data`),
so the mount point moved up one level to `/var/lib/postgresql`.

### Migration steps

**1. infra-compose direct users (soa2/infra):**

```bash
cd ~/dev/soa2/infra

# Stop services
./bin/infra-compose down

# Remove all postgres profile volumes
docker volume ls --filter "name=postgres-profile-" --format "{{.Name}}" | xargs docker volume rm

# Restart — fresh volumes will be created and seeded automatically
./bin/infra-compose up --profile small
```

**2. Thrive:**

```bash
cd ~/dev/thrive

# Pull latest compose-templates-poc branch (includes volume mount fix)
git pull

# Install updated package
pnpm install

# Stop and remove the old volume
docker compose down
docker volume rm thrive-postgres-data

# Restart — databases will be re-created by init-databases.sql
docker compose up -d
```

**3. Consumer repos using `extends:`**

If your `docker-compose.yml` overrides the postgres volume mount, update it:

```yaml
# Before
volumes:
  - my-postgres-data:/var/lib/postgresql/data

# After
volumes:
  - my-postgres-data:/var/lib/postgresql
```

Then remove and recreate the volume:

```bash
docker compose down
docker volume rm <your-postgres-volume-name>
docker compose up -d
```

> **Note:** This is a local-dev-only change. All seed data is re-applied automatically on
> first start. No production databases are affected.

---

## Cross-Repo Usage (npm package)

Consumer repos outside this monorepo can install the service templates as an npm package:

```bash
pnpm add -D @saga-ed/infra-compose
```

Then reference the compose files via `include:` in your project's `docker-compose.yml`:

```yaml
# consumer-repo/docker-compose.yml
include:
  - path: node_modules/@saga-ed/infra-compose/services/mongo/compose.yml
  - path: node_modules/@saga-ed/infra-compose/services/redis/compose.yml

services:
  my-app:
    build: .
    depends_on:
      mongo:
        condition: service_healthy
```

Docker Compose `include:` resolves bind mounts relative to the included file,
so seed scripts at `services/mongo/seed/` resolve correctly from inside `node_modules/`.

### Overriding ports and credentials

The service templates read variables from `.env.defaults` with sensible fallbacks.
Override any value in your project's `.env`:

```env
MONGO_PORT=27020
MYSQL_PORT=3308
SEED_PROFILE=basic
```

Then start services:

```bash
docker compose --env-file .env up -d
```

### What's included in the package

Only the reusable templates are published:

| Included | Excluded (soa-local only) |
|----------|--------------------------|
| `services/` (compose files + seed data) | `Makefile` |
| `.env.defaults` | `projects/` |
| | `README.md` |

The `Makefile` and `projects/` directory are convenience wrappers for soa monorepo
development. Consumer repos use `docker compose` directly.
