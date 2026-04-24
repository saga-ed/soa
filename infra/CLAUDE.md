# infra-compose

Docker Compose template package with instant profile switching. Published as `@saga-ed/infra-compose`.

## Responsibilities

- Standalone Docker Compose templates for MongoDB, MySQL, PostgreSQL, Redis, RabbitMQ, OpenFGA
- Project composition via `include:` (saga-api, adm-api, events-example)
- Volume-per-profile isolation — each seed profile gets its own Docker volume
- Sentinel-based idempotent seeding (init containers skip if `_profile_meta` present)
- CLI (`infra-compose`) + programmatic JS API + Express HTTP router
- EC2 db-host server subsystem for remote fixture-serving VMs

## Parent Context

See [/CLAUDE.md](../CLAUDE.md) for repository-wide context. `infra-compose` is a sibling of `packages/` — not inside it, because it ships as a standalone npm package with its own `package.json`, its own test runner config, and its own CI.

## Tech Stack

- **Runtime**: Node.js 20+ (ESM) — plain JS, no TypeScript compile step (just `.d.ts` handwritten for the public surface)
- **Containers**: Docker Compose v2 (`docker compose`, with `docker-compose` fallback)
- **Database drivers**: `mongodb`, `mysql2/promise` (for direct dump/restore)
- **HTTP**: Express (optional peer dep — only needed for the router)
- **Testing**: Vitest (unit) + bash + real Docker (integration, 11 scenarios)

## Structure

```
infra/
├── bin/
│   ├── infra-compose                    # Bash CLI — wraps src/api.js functions
│   └── infra-compose-completion.bash
├── src/                                 # Runtime JS (published)
│   ├── api.js                           # up/switch/reset/restore/snapshot/list_profiles
│   ├── handlers.js                      # HTTP handler wrappers — { ok: true, … } contract
│   ├── router.js                        # Express router factory with lifecycle hooks
│   ├── *.d.ts                           # Hand-written type declarations
│   └── ec2/                             # EC2 db-host server (separate subsystem)
│       ├── server.js, ec2-router.js
│       ├── volumes.js, ports.js, profiles.js
│       └── engines.js, cloudmap.js, compose-generator.js
├── compose/                             # Docker Compose templates (published)
│   ├── compose.yml                      # Master — all services via include:
│   ├── services/
│   │   ├── mongo/{compose.yml, seed/*}
│   │   ├── mysql/{compose.yml, seed/*}
│   │   ├── postgres/{compose.yml, seed/*}
│   │   ├── redis/compose.yml
│   │   ├── rabbitmq/compose.yml
│   │   └── openfga/compose.yml
│   └── projects/                        # Composition of services for specific apps
│       ├── saga-api.yml
│       ├── adm-api.yml
│       └── events-example.yml
├── test/
│   ├── unit/*.unit.test.js              # Vitest, 70 tests
│   └── integration/run-integration.sh   # Real Docker, 11 scenarios
├── docs/                                # Adoption guide, architecture, API ref, troubleshooting
├── .env.defaults                        # Port + credential defaults
├── Makefile                             # Monorepo convenience targets
└── package.json
```

## Key Exports

```javascript
// Programmatic API
import {
    up, switch_profile, reset, restore, snapshot,
    list_profiles, get_active_profile, delete_profile_data,
} from '@saga-ed/infra-compose';

// HTTP router (requires express peer dep)
import { create_router } from '@saga-ed/infra-compose/router';

// Handler wrappers (for custom router composition)
import {
    handle_snapshot, handle_switch, handle_reset, handle_restore,
    handle_list_profiles, handle_delete_profile, handle_get_active,
} from '@saga-ed/infra-compose/handlers';

// EC2 db-host server (separate subsystem)
import { create_ec2_router } from '@saga-ed/infra-compose/ec2-router';
```

## Three-layer design

```
  ┌───────────────────────────────────────────────┐
  │ Transport layer                               │
  │   bin/infra-compose (CLI)                     │
  │   src/router.js     (Express HTTP)            │
  │   fixture-serve integration                   │
  └───────────────────┬───────────────────────────┘
                      │ passes validated input
  ┌───────────────────▼───────────────────────────┐
  │ Handler layer (src/handlers.js)               │
  │   - profile name validation: /[a-zA-Z0-9_-]+/ │
  │   - sanitize output_dir / data_dir / seed_dir │
  │   - { ok: true, … } vs { ok: false, error: … }│
  └───────────────────┬───────────────────────────┘
                      │
  ┌───────────────────▼───────────────────────────┐
  │ API layer (src/api.js)                        │
  │   - spawn docker compose (with -f resolution) │
  │   - direct DB dump (mongodb + mysql2)         │
  │   - ~/.fixtures/active-profile state file     │
  │   - env precedence: .env.defaults →           │
  │       .env → ~/.fixtures/.env                 │
  └───────────────────────────────────────────────┘
```

## Key Features

**Volume-per-profile isolation.** Each service's compose.yml names its volume
`<service>-profile-${SEED_PROFILE:-small}`. Switching profile = `docker compose
down` + restart with a different `SEED_PROFILE` env var. No data loss between
profiles — all volumes persist.

**Sentinel-based idempotent seeding.** Each data service's `*_init` container
checks for a `_profile_meta` marker (collection in Mongo, table in SQL). If
absent, it loads `seed/profile-<name>.{json,sql}` and writes the marker.
Second `up` on the same volume is a ~1s no-op.

**`compose_file` threading.** All lifecycle functions (`up`, `switch_profile`,
`reset`, `restore`, `snapshot`) accept a `compose_file` option. The HTTP
router also accepts it in `create_router({compose_file})` and threads it
into every handler input. This lets a single fixture-serve instance target
a project-specific compose file (e.g. `compose/projects/saga-api.yml`)
instead of the bundled master `compose/compose.yml`.

**Env file precedence.** `api.js` and `bin/infra-compose` both load three
env files in order: `compose/compose.yml`'s `$PKG_ROOT/.env.defaults`
(bundled defaults, wiped by `npm install -g`), then `$PKG_ROOT/.env`
(project-local, gitignored), then `~/.fixtures/.env` (user-level, survives
reinstalls). Later files override earlier.

**Active profile state.** `~/.fixtures/active-profile` is a JSON file
written by every mutating function (`up`, `switch_profile`, `reset`, `restore`)
and read by `get_active_profile()`. Legacy plain-text format is still
readable (single line = profile name, no `switched_at`).

**Lifecycle hooks (HTTP router).** `create_router` accepts
`on_after_switch`, `on_after_reset`, `on_after_snapshot` async callbacks.
fixture-serve uses these to reconnect MongoDB (so its controllers see the
new profile's data) and to restart the application service via systemd.

## Error handling convention

All HTTP endpoints return `{ ok: true, ... }` on success or
`{ ok: false, error: "..." }` on failure. HTTP status is always 200 unless
a handler throws unexpectedly (500) — the caller checks `ok` to distinguish.
Profile names are validated against `/^[a-zA-Z0-9_-]+$/` before reaching
`api.js`.

## Convention Deviations

- **Published package lives outside `packages/`.** Historically infra-compose
  predates the monorepo layout and ships as a top-level npm package. The
  CLAUDE.md hierarchy acknowledges this by treating `infra/` as a sibling
  of `apps/` and `packages/`.
- **Plain JavaScript (no TypeScript compile step).** `.d.ts` files are
  hand-maintained for the public surface. Rationale: this is long-lived
  infra code that rarely changes shape, and `typecheck` just validates the
  `.d.ts` files against the source.
- **Tests are in `test/` at the package root, not `src/__tests__/`.** The
  unit suite is plain JS + vitest; the integration suite is bash + real
  Docker. Keeping them adjacent (rather than split between source subdirs)
  matches how contributors think about the package.

## See Also

- [README.md](./README.md) — What / Why / Quick start
- [docs/adoption-guide.md](./docs/adoption-guide.md) — 4 adoption contexts
- [docs/architecture.md](./docs/architecture.md) — volume-per-profile + seeding internals
- [docs/api-reference.md](./docs/api-reference.md) — JS + HTTP API contracts
- [docs/troubleshooting.md](./docs/troubleshooting.md) — port conflicts, VPN daemon.json, env precedence
- [/packages/node/fixture-serve/CLAUDE.md](../packages/node/fixture-serve/CLAUDE.md) — downstream consumer that mounts this router

---

*Last updated: 2026-04*
