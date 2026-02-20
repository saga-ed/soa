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
- Lists SOA containers (probably none yet)
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
| `infra/bin/infra-compose` | CLI entry point (bash script) |
| `infra/services/{mongo,mysql,postgres,redis,rabbitmq,openfga}/compose.yml` | Service templates |
| `infra/.env.defaults` | Default ports, credentials, `SEED_PROFILE` |
| `fixture-cli/zcripts/local/docker-compose.yml` | saga_api consumer compose |
| `fixture-cli/zcripts/local/local-db-mgr.sh` | saga_api legacy wrapper |
