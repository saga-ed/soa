# fixture-serve

Ready-to-run Express server for managing test fixtures across database environments.

## Responsibilities

- Abstract controller base class for service-specific fixture APIs
- HTTP endpoints for fixture lifecycle: provision, store/restore, create-async, export-playwright
- Async job queue (MongoDB-backed) with streaming output buffers
- Credential export for Playwright/E2E tests (role mapping → suite-grouped user_logins)
- infra-compose integration (mounts `/infra` router with lifecycle hooks)
- Systemd service restart helper + fixture-admin self-registration

## Parent Context

See [/packages/node/CLAUDE.md](../CLAUDE.md) for Node.js package patterns.

## Tech Stack

- **Server**: Express via `@saga-ed/soa-api-core`'s `ExpressServer`
- **DI**: Inversify
- **HTTP routing**: routing-controllers decorators
- **Database**: MongoDB (metadata + job queue)
- **Validation**: Zod + runtime shape checks
- **Build**: tsc → ESM
- **Testing**: Vitest (unit + integration, 43 tests)

## Structure

```
src/
├── index.ts                                # Public barrel
├── types.ts                                # Shared contracts
├── server/
│   ├── fixture-server.ts                   # FixtureServer class (DI, mount, start/stop)
│   └── admin-registration.ts               # EC2 IMDSv2 + fixture-admin POST
├── controller/
│   └── abstract-fixture-controller.ts      # Base controller — subclass per service
├── utils/
│   └── service-restart.ts                  # Systemd restart + health poll helper
└── __tests__/
    ├── *.unit.test.ts                      # Pure logic (state, roles, output, type resolution)
    └── *.int.test.ts                       # DI wiring, HTTP surface (supertest + MockMongoProvider)
```

## Key Exports

```typescript
// Server — one per service
import { FixtureServer, type FixtureServerConfig } from '@saga-ed/fixture-serve';

// Base controller — subclass per service
import {
    AbstractFixtureController,
    type FixtureControllerConfig,
} from '@saga-ed/fixture-serve';

// Infra-compose hook helper
import { create_service_restarter } from '@saga-ed/fixture-serve';

// Fixture-admin self-registration
import { register_with_admin } from '@saga-ed/fixture-serve';

// Shared contracts
import type {
    FixtureTypeDefinition,
    RoleMapping,
    SuiteRoles,
    JobDocument,
    ProvisionState,
    ProvisionStatus,
} from '@saga-ed/fixture-serve';
```

## Adoption

Adopt by **subclassing `AbstractFixtureController`** with your fixture types, then
instantiating `FixtureServer`:

```typescript
import { FixtureServer, AbstractFixtureController, type FixtureTypeDefinition } from '@saga-ed/fixture-serve';
import { Controller } from 'routing-controllers';
import { injectable } from 'inversify';

@injectable()
@Controller('/fixture')
class MyFixtureController extends AbstractFixtureController {
    get fixtures_dir() { return '/opt/my-service/fixtures'; }

    get fixture_types(): Record<string, FixtureTypeDefinition> {
        return {
            'small':  { name: '5 users',  est_seconds: 30 },
            'large':  { name: '50 users', est_seconds: 120,
                        creator: async opts => { /* seed DB programmatically */ } },
        };
    }

    get role_mappings() { return { TUTOR: ['TUTOR'], SCHOLAR: ['STUDENT'] }; }
    get suite_roles()   { return { auth: ['TUTOR', 'STUDENT'] }; }
}

const server = new FixtureServer({
    port: 7777,
    service_name: 'my_api-*',                          // systemd pattern for restart
    health_url: 'http://localhost:3000/health',
    mongo_uri: 'mongodb://localhost:27018',            // infra-compose's offset port
    db_name: 'my_test_db',
    site_url: 'http://localhost:3000',
    default_profile: 'small',                          // infra-compose seed profile
    compose_file: '/opt/my-service/compose/my-api.yml',// project-specific compose
    controllers: [MyFixtureController],
});
await server.start();
```

The server then exposes (prefixed by the `@Controller` path):

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Server status, version, active profile |
| `/infra/*` | various | Full infra-compose router (switch/reset/snapshot/…) |
| `/fixture/create-types` | GET | List available fixture types |
| `/fixture/create-async` | POST | Queue async fixture creation; returns `job_id` |
| `/fixture/create-status/:id` | GET | Poll job state + streamed output |
| `/fixture/provision` | POST | One-shot: reset → create → snapshot → verify |
| `/fixture/provision-status` | GET | Poll provision state machine |
| `/fixture/store` (alias `/snapshot`) | POST | Snapshot current DB as named profile |
| `/fixture/restore` | POST | Switch to previously snapshotted profile |
| `/fixture/readiness` | GET | VM name, active profile, has_playwright_env |
| `/fixture/export-playwright` | GET | Build credential export for E2E tests |

## Key Features

**DI wiring.** Standard bindings for `ILogger`, `ExpressServerConfig`,
`FixtureControllerConfig`, `IMongoConnMgr`, `MONGO_CLIENT`. Expose via
`server.getContainer()` for hook overrides.

**infra-compose integration.** The `/infra` subtree is mounted with lifecycle
hooks that (by default) reconnect MongoDB + restart the configured systemd
service after `switch_profile`/`reset`. Override via `infra_hooks:{...}`.

**Async jobs.** Fixture creation runs in the background; clients poll
`/create-status/:id` for streamed output (2s MongoDB flush interval) and
completion status. Both TS creators (inline functions) and bash scripts
(`create-fixture-{type}.sh` in `fixtures_dir`) are supported.

**Provision state machine.** Tracked via `ProvisionState` with transitions
`resetting → creating → switching → verifying → ready/failed`. Concurrent
provisions are rejected until the current run reaches `ready` or `failed`.

**Playwright export.** `build_playwright_export(fixture_id, base_url)` reads
metadata from Mongo, applies `role_mappings` (domain role → playwright roles)
then `suite_roles` (suite → required roles), returning
`{ user_logins: { suite: { role: [{username, password, user_type}] } }, fixture_data, baseUrl }`.

**Fixture-admin self-registration.** On startup, if `admin_register_url`
(or `FIXTURE_ADMIN_URL` env) is set, `register_with_admin` POSTs a payload
with `{hostname, private_ip, port, site_url, version, active_profile}` —
private IP via EC2 IMDSv2, or `127.0.0.1` fallback. Failures are logged,
never thrown.

## Convention Deviations

None — mirrors the api-core / db CLAUDE.md pattern.

## See Also

- [README.md](./README.md) — What / Why / How to adopt (4 contexts)
- [/infra/CLAUDE.md](../../../infra/CLAUDE.md) — infra-compose internals this depends on
- `/packages/node/api-core/CLAUDE.md` — the ExpressServer it extends
- `/packages/node/db/CLAUDE.md` — MongoProvider + MockMongoProvider used in tests

---

*Last updated: 2026-04*
