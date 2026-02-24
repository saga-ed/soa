# Hands-On Tutorial: infra-compose & Profile Switching

A guided walkthrough of the `@saga-ed/infra-compose` package — composable Docker service templates with profile-based volume switching. This is not a reference doc — it is a sequence of commands you run, observe, and learn from.

## Table of Contents

- [Prerequisites](#prerequisites)
- [PART 1: Explore the Package (~10 min)](#part-1-explore-the-package-10-min)
  - [1.1 Service templates](#11-service-templates)
  - [1.2 The CLI](#12-the-cli)
- [PART 2: Profile Switching (~15 min)](#part-2-profile-switching-15-min)
  - [2.1 Start with small profile](#21-start-with-small-profile)
  - [2.2 Switch to basic](#22-switch-to-basic)
  - [2.3 Switch back to small](#23-switch-back-to-small)
  - [2.4 Reset a profile](#24-reset-a-profile)
  - [2.5 Down (preserve everything)](#25-down-preserve-everything)
- [PART 3: Consumer Integration — saga_api (~15 min)](#part-3-consumer-integration--saga_api-15-min)
  - [3.1 The extends pattern](#31-the-extends-pattern)
  - [3.2 Run from saga_api directory](#32-run-from-saga_api-directory)
  - [3.3 The local-db-mgr.sh wrapper](#33-the-local-db-mgrsh-wrapper)
- [PART 4: Project-Specific Seed Data (~15 min)](#part-4-project-specific-seed-data-15-min)
  - [4.1 How template seeding works](#41-how-template-seeding-works)
  - [4.2 Create project seed profiles](#42-create-project-seed-profiles)
  - [4.3 Define a project-specific mongo_init service](#43-define-a-project-specific-mongo_init-service)
  - [4.4 Test profile switching with different data](#44-test-profile-switching-with-different-data)
  - [4.5 Alternative: docker-entrypoint-initdb.d](#45-alternative-docker-entrypoint-initdbd)
- [Appendix: Command Cheat Sheet](#appendix-command-cheat-sheet)

## Prerequisites

Before starting, confirm you have:

- [ ] Docker and Docker Compose v2 installed
- [ ] Node.js 20+
- [ ] `soa2` repo cloned, on branch `gh_27-compose_of_composes`
- [ ] `saga_api` (nb2) repo cloned, on branch `gh_7763-compose_of_composes_poc`

Verify your environment:

```bash
docker compose version       # → Docker Compose version v2.x.x
node --version               # → v20.x.x or higher
cd ~/dev/soa2
git branch --show-current    # → gh_27-compose_of_composes
ls infra/bin/infra-compose   # → exists
ls infra/services/           # → mongo/ mysql/ postgres/ redis/ rabbitmq/ openfga/
```

**Reset instructions** appear at the end of each section. Three levels:

| Level | When | Command |
|-------|------|---------|
| **Light** | Stop containers only | `npx infra-compose down` |
| **Full** | Stop containers + remove all profile volumes | `docker compose down -v` |
| **None** | Read-only exercise, nothing to clean | — |

---

## PART 1: Explore the Package (~10 min)

Orientation — understand what ships in the package before running anything.

### 1.1 Service templates

List the available service templates:

```bash
ls infra/services/
```

You'll see: `mongo/`, `mysql/`, `postgres/`, `redis/`, `rabbitmq/`, `openfga/`. Each directory contains a `compose.yml` template that any consumer can `extends:` from.

Now look at the root compose file:

```bash
cat infra/compose.yml
```

**What to observe:**
- Uses Docker Compose `include:` to pull in all service templates — this is the "compose of composes" pattern
- OpenFGA is excluded because it requires a pre-created `openfga` database in Postgres; include it in project-specific compose files that set up the database

Now read the Mongo template:

```bash
cat infra/services/mongo/compose.yml
```

**What to observe:**
- The volume is defined with a **dynamic name**: `name: mongo-profile-${SEED_PROFILE:-small}`
- This means each profile (small, basic, large, etc.) gets its own isolated Docker volume
- The `mongo_init` service runs seed scripts from `./seed/` with `SEED_PROFILE` as an env var
- The seeder checks a sentinel doc and skips if already seeded — idempotent by design

Now read the defaults file:

```bash
cat infra/.env.defaults
```

**What to observe:**
- `SEED_PROFILE=small` — the default profile name
- Ports are offset from standard (e.g., Mongo on 27018 instead of 27017) to avoid conflicts with `local-db-mgr` legacy setup
- Credentials are local-dev-only placeholders (never for CI/staging/production)

The flow: `.env.defaults` sets `SEED_PROFILE=small` → CLI reads it → passes to Docker Compose → volume name becomes `mongo-profile-small`.

**What you learned:** Service templates are composable Docker Compose files with dynamic volume names driven by `SEED_PROFILE`. The env cascade is: `--profile` flag > env var > `.env.defaults` > hardcoded `"small"`.

> **Reset:** None — read-only.

### 1.2 The CLI

See all available commands:

```bash
cd ~/dev/soa2/infra
npx infra-compose help
```

**What to observe:**
- **Lifecycle commands**: `up`, `switch`, `down`, `reset` — the core profile workflow
- **Utility commands**: `check-ports`, `status`, `shell`, `list-profiles`, `volumes`
- The `--` separator passes extra args through to `docker compose` (e.g., `-- -f docker-compose.yml`)

Check the current state:

```bash
npx infra-compose status
```

**What to observe:**
- Shows `Current SEED_PROFILE` (from env or default)
- Lists infra-compose containers (probably none yet)
- Lists other running containers (anything else Docker is running)
- Lists all profile volumes (probably none yet)

**What you learned:** The CLI wraps `docker compose` with profile awareness. It sources `.env.defaults`, overlays your local `.env`, then dispatches to Docker Compose with `SEED_PROFILE` exported.

> **Reset:** None — read-only.

---

## PART 2: Profile Switching (~15 min)

The core workflow. You will start services, switch between profiles, and verify data isolation.

### 2.1 Start with small profile

```bash
cd ~/dev/soa2/infra
npx infra-compose up --profile small
```

**What to observe:**
- Port check runs first — if any ports are in use, you get an error with specific `docker stop` commands to resolve conflicts
- Docker Compose starts the services in detached mode
- Output shows `Profile: small` and lists the created volumes

Verify the volumes:

```bash
docker volume ls --filter "name=-profile-"
```

**What to observe:**
- Volumes are named `*-profile-small` (e.g., `mongo-profile-small`, `mysql-profile-small`, `postgres-profile-small`)
- Each database service gets its own isolated volume per profile

Check containers:

```bash
npx infra-compose status
```

You should see the database containers running with their ports mapped.

**What you learned:** `up` does three things in order: port conflict check, export `SEED_PROFILE`, then `docker compose up -d`.

> **Reset:** Light — `npx infra-compose down`

### 2.2 Switch to basic

```bash
npx infra-compose switch --profile basic
```

**What to observe:**
- The CLI runs `docker compose down` (stops containers) then `docker compose up -d` with `SEED_PROFILE=basic`
- Output shows `Switched to profile: basic`

Now check volumes:

```bash
docker volume ls --filter "name=-profile-"
```

**What to observe:**
- **Both** `small` AND `basic` volumes exist — switching does NOT delete the old profile
- The `small` data is preserved on disk, just not mounted
- The `basic` volumes are fresh (empty or freshly seeded)

**What you learned:** `switch` is non-destructive. It stops services and restarts with a different volume set. Old profiles remain on disk.

> **Reset:** None — keep running for next step.

### 2.3 Switch back to small

```bash
npx infra-compose switch --profile small
```

**What to observe:**
- Instant switch — the `small` volumes already exist with their previous data
- No re-seeding needed because the seeder checks a sentinel and skips if present
- All your previous `small` data is exactly as you left it

**What you learned:** Profile switching is fast and bidirectional. Your data survives across switches.

> **Reset:** None — keep running for next step.

### 2.4 Reset a profile

```bash
npx infra-compose reset --profile basic
```

**What to observe:**
- Stops services
- Finds and removes all volumes matching `*-profile-basic`
- Restarts services — new empty `basic` volumes are created
- Output: `Reset profile: basic — volumes wiped, services restarted`

Verify:

```bash
docker volume ls --filter "name=-profile-"
```

**What to observe:**
- `small` volumes are **untouched** — reset only affects the named profile
- `basic` volumes are recreated (fresh)

**What you learned:** `reset` is targeted destruction — it wipes one profile's volumes and restarts. Other profiles are safe.

> **Reset:** None — keep running for next step.

### 2.5 Down (preserve everything)

```bash
npx infra-compose down
```

Verify:

```bash
docker volume ls --filter "name=-profile-"
```

**What to observe:**
- All containers are gone
- All volumes still exist — `down` never removes volumes
- Next `up` will mount the existing volumes (no data loss)

```bash
npx infra-compose status
```

Containers section shows `(none)`. Profile volumes section still lists all your volumes.

**What you learned:** `down` is safe. It stops containers but preserves all profile data. Use `reset` when you actually want to wipe data.

> **Reset:** Full — if you want to clean up everything:
> ```bash
> docker volume ls --filter "name=-profile-" --format "{{.Name}}" | xargs docker volume rm
> ```

---

## PART 3: Consumer Integration — saga_api (~15 min)

How a real application consumes `@saga-ed/infra-compose` templates.

### 3.1 The extends pattern

Read the saga_api Docker Compose file:

```bash
cat ~/dev/nb2/edu/js/app/saga_api/fixture-cli/zcripts/local/docker-compose.yml
```

**What to observe:**

1. **`extends:` from templates** — each service extends the package template:
   ```yaml
   mongo_service:
     extends:
       file: ${INFRA_COMPOSE_DIR:-./node_modules/@saga-ed/infra-compose/services}/mongo/compose.yml
       service: mongo
   ```
   The `INFRA_COMPOSE_DIR` env var allows overriding for local development (symlinked packages).

2. **Consumer overrides** — saga_api customizes the template:
   - `container_name: mongo-6-local` — app-specific naming
   - `network_mode: "host"` — saga_api uses host networking
   - Extra `ulimits` for Mongo

3. **Prefixed volume names** — volumes are namespaced to the consumer:
   ```yaml
   volumes:
     mongo-data:
       name: saga-api-mongo-profile-${SEED_PROFILE:-small}
   ```
   This means saga_api volumes (`saga-api-mongo-profile-small`) are completely separate from the raw template volumes (`mongo-profile-small`). Multiple consumers can coexist.

4. **saga_api-specific init** — Mongo replica set init is inline (not from the template) because saga_api needs a specific replica set config.

**What you learned:** The `extends:` pattern lets consumers inherit image, healthcheck, ports, and volume structure from the template while overriding container names, networking, env vars, and adding extra volumes.

> **Reset:** None — read-only.

### 3.2 Run from saga_api directory

```bash
cd ~/dev/nb2/edu/js/app/saga_api/fixture-cli/zcripts/local/
npx infra-compose up --profile small -- -f docker-compose.yml
```

**What to observe:**
- The `--` separator passes `-f docker-compose.yml` through to `docker compose`
- This tells Docker Compose to use saga_api's compose file (not the package's default)
- Port check runs against the ports defined in saga_api's compose file
- Volumes are created with saga_api's prefixed names

Verify:

```bash
docker volume ls --filter "name=saga-api"
```

You should see volumes like:
- `saga-api-mongo-profile-small`
- `saga-api-mysql-profile-small`

**What you learned:** The `-- ARGS` passthrough is how consumers point infra-compose at their own compose file. The CLI handles profile resolution and port checking; Docker Compose handles the service definitions.

> **Reset:** Light — `npx infra-compose down -- -f docker-compose.yml`

### 3.3 The local-db-mgr.sh wrapper

Read the wrapper functions:

```bash
head -90 ~/dev/nb2/edu/js/app/saga_api/fixture-cli/zcripts/local/local-db-mgr.sh
```

**What to observe:**

The script has two key functions that bridge the legacy workflow to infra-compose:

```bash
# Check if infra-compose CLI is available
has_infra_compose() {
    command -v infra-compose &>/dev/null || npx --yes infra-compose help &>/dev/null 2>&1
}

# Run infra-compose with passthrough to the local compose file
run_infra_compose() {
    local cmd="$1"; shift
    if command -v infra-compose &>/dev/null; then
        infra-compose "$cmd" "$@" -- -f "$COMPOSE_FILE"
    else
        npx --yes @saga-ed/infra-compose "$cmd" "$@" -- -f "$COMPOSE_FILE"
    fi
}
```

- `has_infra_compose()` checks if the CLI is available (globally or via npx)
- `run_infra_compose()` wraps every call to append `-- -f $COMPOSE_FILE`

The `start_databases()` function uses this pattern:

```bash
if has_infra_compose; then
    print_info "Using infra-compose CLI..."
    run_infra_compose up --profile "$SEED_PROFILE"
else
    print_info "infra-compose not available, using docker compose directly..."
    # ... fallback to raw docker compose
fi
```

Try it:

```bash
cd ~/dev/nb2/edu/js/app/saga_api/fixture-cli/zcripts/local/
./local-db-mgr.sh start           # Uses infra-compose when available
./local-db-mgr.sh switch basic    # Profile switching via wrapper
./local-db-mgr.sh check           # Status check
```

**What you learned:** Existing scripts get profile switching for free by wrapping `infra-compose`. The `has_infra_compose` / `run_infra_compose` pattern provides graceful fallback — if the package isn't installed, the script falls back to raw `docker compose`.

> **Reset:** Light — `./local-db-mgr.sh stop`

---

## PART 4: Project-Specific Seed Data (~15 min)

How to define your own seed profiles with project-specific data that varies per profile. PART 2 showed how the **template** seeds generic data; here you'll build **project-level** seed profiles that load different data depending on which profile is active.

### 4.1 How template seeding works

Before building your own, read the template's seeder to understand the mechanism.

```bash
cat infra/services/mongo/seed/init-and-seed.js
```

**What to observe:**

1. **Replica set init** (lines 9–20) — idempotent `rs.initiate()` with a try/catch guard
2. **Wait for primary** (lines 22–51) — polls `rs.status()` and probes a write before continuing
3. **Sentinel check** (lines 60–64) — looks for a `_profile_meta` doc matching the current profile. If found, the seeder prints "already seeded" and exits. This is what makes seeding **idempotent** across restarts and switches.
4. **Profile file loading** (lines 66–82) — reads `/seed/profile-${SEED_PROFILE}.json`, iterates `{ db: { collection: [docs] } }`, and inserts docs via `insertMany`
5. **Sentinel write** (lines 84–89) — after successful seeding, writes the sentinel doc so future runs skip

Now read a profile file:

```bash
cat infra/services/mongo/seed/profile-small.json
```

**What to observe:**
- Top-level keys are **database names** (`saga_db`, `ars_db`)
- Second-level keys are **collection names** (`organizations`, `users`, etc.)
- Values are arrays of documents to insert
- This is the contract: any JSON file matching this shape will work with `init-and-seed.js`

**What you learned:** The template seeder is a generic engine — it loads any profile JSON that conforms to `{ db: { collection: [docs] } }`. Projects provide their own seed data by mounting their own profile JSON files at `/seed/`.

> **Reset:** None — read-only.

### 4.2 Create project seed profiles

Create a seed directory with two profile files that contain different data. We'll use a fictional `myapp` project as the example.

```bash
mkdir -p /tmp/myapp-seed-demo/seed
```

Create the small profile — one org, one user:

```bash
cat > /tmp/myapp-seed-demo/seed/profile-small.json << 'EOF'
{
  "myapp_db": {
    "tenants": [
      {
        "name": "Acme School",
        "slug": "acme",
        "plan": "free",
        "created_at": "2025-01-01T00:00:00Z"
      }
    ],
    "users": [
      {
        "email": "admin@acme.edu",
        "name": "Alice Admin",
        "role": "admin",
        "tenant_slug": "acme"
      }
    ]
  }
}
EOF
```

Create the basic profile — two orgs, four users:

```bash
cat > /tmp/myapp-seed-demo/seed/profile-basic.json << 'EOF'
{
  "myapp_db": {
    "tenants": [
      {
        "name": "Acme School",
        "slug": "acme",
        "plan": "pro",
        "created_at": "2025-01-01T00:00:00Z"
      },
      {
        "name": "Beta Academy",
        "slug": "beta",
        "plan": "enterprise",
        "created_at": "2025-02-01T00:00:00Z"
      }
    ],
    "users": [
      {
        "email": "admin@acme.edu",
        "name": "Alice Admin",
        "role": "admin",
        "tenant_slug": "acme"
      },
      {
        "email": "teacher@acme.edu",
        "name": "Ted Teacher",
        "role": "teacher",
        "tenant_slug": "acme"
      },
      {
        "email": "admin@beta.edu",
        "name": "Bob Boss",
        "role": "admin",
        "tenant_slug": "beta"
      },
      {
        "email": "teacher@beta.edu",
        "name": "Tina Teach",
        "role": "teacher",
        "tenant_slug": "beta"
      }
    ]
  }
}
EOF
```

Verify the files:

```bash
ls /tmp/myapp-seed-demo/seed/
```

You should see `profile-small.json` and `profile-basic.json`.

**What you learned:** Profile JSON files follow the same `{ db: { collection: [docs] } }` contract as the template. You control what data each profile contains — different record counts, different field values, different collections.

> **Reset:** `rm -rf /tmp/myapp-seed-demo/seed`

### 4.3 Define a project-specific mongo_init service

Now create a Docker Compose file that extends the template's `mongo` service and defines its own `mongo_init` that mounts the local seed directory.

```bash
cat > /tmp/myapp-seed-demo/docker-compose.yml << 'YAML'
## myapp local databases — extends @saga-ed/infra-compose templates
##
## Profile switching: volumes use SEED_PROFILE for isolation.
##   npx infra-compose up --profile small -- -f docker-compose.yml
##   npx infra-compose switch --profile basic -- -f docker-compose.yml

services:

  mongo:
    extends:
      file: ${INFRA_COMPOSE_DIR:-./node_modules/@saga-ed/infra-compose/services}/mongo/compose.yml
      service: mongo
    container_name: myapp-mongo
    volumes:
      - myapp-mongo-data:/data/db

  mongo_init:
    image: mongo:6
    depends_on:
      mongo:
        condition: service_healthy
    volumes:
      # Mount the template's seeder script (the generic engine)
      - ${INFRA_COMPOSE_DIR:-./node_modules/@saga-ed/infra-compose/services}/mongo/seed/init-and-seed.js:/seed/init-and-seed.js:ro
      # Mount YOUR project-specific profile JSON files
      - ./seed:/seed-profiles:ro
    environment:
      SEED_PROFILE: ${SEED_PROFILE:-small}
    # Copy project profiles into /seed/ alongside the script, then run
    entrypoint:
      - sh
      - -c
      - |
        cp /seed-profiles/profile-*.json /seed/
        mongosh --host mongo:27017 --file /seed/init-and-seed.js
    restart: "no"

volumes:
  myapp-mongo-data:
    name: myapp-mongo-profile-${SEED_PROFILE:-small}
YAML
```

**What to observe:**

1. **`mongo` extends the template** — inherits image, healthcheck, replica set command, and ports
2. **Volume is consumer-prefixed** — `myapp-mongo-profile-${SEED_PROFILE}` keeps this project's data separate from other consumers
3. **`mongo_init` is project-defined** — not inherited from the template. It mounts two things:
   - The template's `init-and-seed.js` — the generic seeding engine
   - The project's `./seed/` directory — your profile-specific JSON files
4. **Entrypoint copies profiles** — the `sh -c` entrypoint copies your profile JSONs into `/seed/` so `init-and-seed.js` can find them at `/seed/profile-${SEED_PROFILE}.json`
5. **Same sentinel mechanism** — `init-and-seed.js` writes a `_profile_meta` sentinel, so re-running `up` won't re-insert data

**What you learned:** Define your own `mongo_init` service that reuses the template's seeder script but mounts your own profile data. The template engine is generic — you control what data it loads.

> **Reset:** `rm /tmp/myapp-seed-demo/docker-compose.yml`

### 4.4 Test profile switching with different data

> **Note:** This exercise requires the soa2 `infra/` package to be resolvable. If you are working from `/tmp/myapp-seed-demo/`, set `INFRA_COMPOSE_DIR` to point to your local soa2 checkout:
> ```bash
> export INFRA_COMPOSE_DIR=~/dev/soa2/infra/services
> ```

Start with the small profile:

```bash
cd /tmp/myapp-seed-demo
npx infra-compose up --profile small -- -f docker-compose.yml
```

Wait for init to finish, then query Mongo:

```bash
docker exec myapp-mongo mongosh --quiet --eval '
  db.getSiblingDB("myapp_db").tenants.countDocuments()
'
```

Expected: `1` (Acme School only)

```bash
docker exec myapp-mongo mongosh --quiet --eval '
  db.getSiblingDB("myapp_db").users.countDocuments()
'
```

Expected: `1` (Alice Admin only)

Now switch to basic:

```bash
npx infra-compose switch --profile basic -- -f docker-compose.yml
```

Query again:

```bash
docker exec myapp-mongo mongosh --quiet --eval '
  db.getSiblingDB("myapp_db").tenants.countDocuments()
'
```

Expected: `2` (Acme School + Beta Academy)

```bash
docker exec myapp-mongo mongosh --quiet --eval '
  db.getSiblingDB("myapp_db").users.countDocuments()
'
```

Expected: `4` (two users per org)

Now switch back to small:

```bash
npx infra-compose switch --profile small -- -f docker-compose.yml
```

Query one more time:

```bash
docker exec myapp-mongo mongosh --quiet --eval '
  db.getSiblingDB("myapp_db").tenants.countDocuments()
'
```

Expected: `1` — your small data is exactly as you left it. No re-seeding occurred because the sentinel was already present.

Verify both volumes exist:

```bash
docker volume ls --filter "name=myapp-mongo-profile"
```

You should see:
- `myapp-mongo-profile-small`
- `myapp-mongo-profile-basic`

**What you learned:** Project-specific seed profiles work identically to the template's built-in profiles. Each profile gets its own Docker volume with different data, and switching is instant and non-destructive.

> **Reset:** Full —
> ```bash
> npx infra-compose down -- -f docker-compose.yml
> docker volume ls --filter "name=myapp-mongo-profile" --format "{{.Name}}" | xargs docker volume rm
> rm -rf /tmp/myapp-seed-demo
> ```

### 4.5 Alternative: docker-entrypoint-initdb.d (simpler, no profiles)

Not every project needs profile switching. If you have a single dataset that you want loaded on first boot, Mongo's native `docker-entrypoint-initdb.d` mechanism is simpler.

Read how Coach uses this pattern:

```bash
cat ~/dev/coach/apps/node/coach-api/docker-compose.yml
```

**What to observe:**

1. **No `mongo_init` sidecar** — Coach doesn't define a separate init service
2. **Volumes mount init scripts directly** into the container:
   ```yaml
   volumes:
     - coach-mongo-data:/data/db
     - ./scripts/mongo-init.js:/docker-entrypoint-initdb.d/init.js:ro
     - ./scripts/data:/docker-entrypoint-initdb.d/data:ro
   ```
3. **No replica set** — Coach uses standalone Mongo (`mongod --bind_ip_all`), which is when `docker-entrypoint-initdb.d` runs (it does **not** run with `--replSet`)
4. **Volume is still profile-named** — `coach-mongo-profile-${SEED_PROFILE}` so you still get volume isolation per profile, even though the seed data is the same across profiles

Now read the init script:

```bash
cat ~/dev/coach/apps/node/coach-api/scripts/mongo-init.js
```

**What to observe:**
- Creates collections and indexes explicitly
- Reads JSON data files from `/docker-entrypoint-initdb.d/data/`
- Uses `db.getSiblingDB()` for a second database
- No sentinel check needed — `docker-entrypoint-initdb.d` only runs when the volume is empty (first start)

**When to use which pattern:**

| | Template seeder (`mongo_init`) | `docker-entrypoint-initdb.d` |
|---|---|---|
| **Runs when** | Every `docker compose up` (sentinel skips re-seed) | Only on first start (empty volume) |
| **Requires** | Sidecar service + `init-and-seed.js` | Volume mount into container |
| **Replica set** | Yes (initializes RS first) | No (requires standalone mode) |
| **Profile-aware** | Yes (different data per profile) | No (same script regardless of `SEED_PROFILE`) |
| **Idempotency** | Sentinel doc in `_profile_meta` | Volume existence (empty = run, non-empty = skip) |
| **Re-seed** | `reset --profile NAME` deletes volume + sentinel | Delete volume, restart container |
| **Best for** | Multi-profile workflows, RS-dependent apps | Single-dataset projects, simple setups |

**What you learned:** Two seeding patterns exist. The template seeder (`mongo_init` + `init-and-seed.js`) is the full-featured option with profile awareness, sentinel-based idempotency, and replica set support. The `docker-entrypoint-initdb.d` pattern is simpler but doesn't support profile-specific data or replica sets.

> **Reset:** None — read-only.

---

## Appendix: Command Cheat Sheet

### Lifecycle Commands

| Command | What it does |
|---------|-------------|
| `up --profile NAME` | Set `SEED_PROFILE`, run port check, `docker compose up -d` |
| `switch --profile NAME` | `down` + `up` with the new profile |
| `down` | Stop services, preserve all volumes |
| `reset --profile NAME` | `down` + remove `*-profile-NAME` volumes + `up` fresh |

### Utility Commands

| Command | What it does |
|---------|-------------|
| `status` | Show containers, current profile, and volumes |
| `check-ports` | Scan Docker for port conflicts before starting |
| `shell <service>` | Open a database shell (`mongo`, `mysql`, `postgres`, `redis`) |
| `list-profiles` | Show available seed profiles per service |
| `volumes` | List all profile Docker volumes |
| `help` | Show the help message |

### Profile Resolution Order

```
--profile flag  >  SEED_PROFILE env var  >  .env.defaults  >  "small"
```

### Volume Naming Convention

| Context | Volume name pattern |
|---------|-------------------|
| Raw template | `mongo-profile-${SEED_PROFILE}` |
| saga_api consumer | `saga-api-mongo-profile-${SEED_PROFILE}` |
| Any consumer | `<prefix>-mongo-profile-${SEED_PROFILE}` |

### Key Files

| File | Purpose |
|------|---------|
| `infra/compose.yml` | Root compose-of-composes (includes all services) |
| `infra/bin/infra-compose` | CLI entry point (bash script) |
| `infra/services/{mongo,mysql,postgres,redis,rabbitmq,openfga}/compose.yml` | Service templates |
| `infra/.env.defaults` | Default ports, credentials, `SEED_PROFILE` |
| `fixture-cli/zcripts/local/docker-compose.yml` | saga_api consumer compose |
| `fixture-cli/zcripts/local/local-db-mgr.sh` | saga_api legacy wrapper |
