# @saga-ed/infra-compose

**Composable Docker service templates with instant profile switching for local development and E2E test infrastructure.**

## What it does

Bundled Docker Compose templates for MongoDB, MySQL, PostgreSQL, Redis, RabbitMQ, and OpenFGA — plus a CLI, a JS API, and an Express router that orchestrate **volume-per-profile isolation**. Switching from the `small` profile to `basic` takes ~3–5 seconds (if the volume has been seeded once); resetting a profile is a single command.

Published to npm as `@saga-ed/infra-compose`. Consumers include the bundled templates via `docker compose` `include:` syntax — no hand-rolled local compose files needed.

## Why you'd use it

| You have | Without infra-compose | With infra-compose |
|---|---|---|
| Multiple projects needing different DB combinations | Copy-paste compose files, maintain parallel init scripts | `include:` the canonical service files, pick your profile |
| Need to switch between data states for testing | Manual dump/restore, restart containers, ~30–60s | `infra-compose switch --profile basic` — ~5s |
| E2E test suite needs known DB state | Hand-rolled teardown/reseed per run | `POST /infra/reset` from your test harness |
| Port conflicts with system DBs or VPN | Debug each collision manually | Pre-offset ports (27018, 3307, 5433, 6380) + pre-flight check |
| `npm install -g` wipes your `.env` overrides | Annoyed | `.env.defaults` (bundled) → `.env` (project) → `~/.fixtures/.env` (survives reinstalls) |

## Quick start

```bash
cd infra

# 1. Bring up saga-api (mongo + mysql) with the "small" seed
make up PROJECT=saga-api

# 2. Switch to "basic" — instant after first seed
make switch PROJECT=saga-api PROFILE=basic

# 3. Stop everything (volumes preserved)
make down PROJECT=saga-api
```

Or via the CLI from any cwd:

```bash
npx infra-compose up --profile small
npx infra-compose switch --profile basic
npx infra-compose status
```

## Projects and services

| Project | Services | Use case |
|---|---|---|
| `saga-api` | mongo, mysql | Main GraphQL/REST API |
| `adm-api` | postgres, redis | Attendance & Daily Management API |
| `events-example` | rabbitmq, postgres | Event-driven example |

| Service | Port | Profile switching | Volume pattern |
|---|---|---|---|
| MongoDB | 27018 | Yes | `mongo-profile-<name>` |
| MySQL | 3307 | Yes | `mysql-profile-<name>` |
| PostgreSQL | 5433 | Yes | `postgres-profile-<name>` |
| Redis | 6380 | No | `redis-data` |
| RabbitMQ | 5673 / 15673 | No | `rabbitmq-data` |

## Depth reading

| Topic | Where |
|---|---|
| Architecture (volume-per-profile, sentinel seeding, `compose_file` threading) | [docs/architecture.md](./docs/architecture.md) |
| Four adoption contexts (local dev, snapper VM, CI, external npm consumer) | [docs/adoption-guide.md](./docs/adoption-guide.md) |
| JS API + HTTP endpoints + `{ ok, ... }` contract | [docs/api-reference.md](./docs/api-reference.md) |
| Port conflicts, VPN / `daemon.json`, init timeouts, env precedence | [docs/troubleshooting.md](./docs/troubleshooting.md) |
| Hands-on walkthrough for snapper VM | [docs/hands-on-tutorial.md](./docs/hands-on-tutorial.md) |
| Contributor-facing internals (three-layer design, extension points) | [CLAUDE.md](./CLAUDE.md) |

## Repository structure

```
infra/
├── bin/infra-compose               # CLI (bash)
├── src/                            # Runtime JS
│   ├── api.js                      # Programmatic API (up/switch/reset/…)
│   ├── handlers.js                 # HTTP handler wrappers ({ ok: … } contract)
│   ├── router.js                   # Express router factory
│   └── ec2/                        # EC2 db-host server (separate subsystem)
├── compose/                        # Docker Compose templates
│   ├── compose.yml                 # Master "all services" file
│   ├── services/{mongo,mysql,postgres,redis,rabbitmq,openfga}/
│   └── projects/{saga-api,adm-api,events-example}.yml
├── test/
│   ├── unit/                       # Vitest unit tests
│   └── integration/                # Bash + Docker integration suite
├── docs/                           # Human-readable guides
├── .env.defaults                   # Port/credential defaults
├── Makefile                        # Developer convenience targets
└── package.json                    # Published as @saga-ed/infra-compose
```

## Relationship to fixture-serve

[`@saga-ed/fixture-serve`](../packages/node/fixture-serve/README.md) is a higher-level Express server that **mounts infra-compose's router at `/infra`** and adds fixture-specific endpoints (provision, snapshot, Playwright credential export). If you want fixture management on top of profile switching, adopt fixture-serve; if you just need database profile orchestration, use infra-compose directly.

## License

Internal — Saga Education.
