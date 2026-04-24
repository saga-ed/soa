# @saga-ed/fixture-serve

**Ready-to-run Express server for managing test fixtures across MongoDB/MySQL/Postgres environments.**

## What it does

Exposes an HTTP API for the fixture lifecycle — provision, snapshot, restore, and credential export — on top of [`@saga-ed/infra-compose`](../../../infra/README.md)'s volume-per-profile Docker stack. Subclass one abstract controller per service, instantiate `FixtureServer`, and the server handles:

- `/fixture/provision` — reset → create → snapshot → verify in one call, with `/fixture/provision-status` polling
- `/fixture/create-async` + `/fixture/create-status/:id` — long-running fixture creation with streamed output
- `/fixture/export-playwright` — emit role-mapped `user_logins` and `fixture_data` for Playwright tests
- `/infra/*` — full infra-compose router (switch/reset/snapshot/restore) with MongoDB reconnect hooks
- `/health` — service + active profile

## Why you'd use it

Before: each service hand-rolled its own fixture CLI, Playwright credential exporter, service-restart glue, and fixture-admin registration. Every project reinvented the same wheels with minor variations.

After: inherit `AbstractFixtureController`, declare `fixture_types` + `role_mappings` + `suite_roles`, and the HTTP surface, job queue, profile-switching hooks, and credential export are all wired up — leaving your service to care only about *its* domain data.

## How to adopt

### 1. Local dev workstation

For iterative work on a single service:

```bash
# 1. Bring up infra-compose databases
cd ~/dev/infra && npx infra-compose up --profile small

# 2. Boot fixture-serve alongside your service
cd ~/dev/my-service && pnpm install @saga-ed/fixture-serve
# wire up src/fixture-controller.ts + src/fixture-server.ts (see below)
pnpm ts-node src/fixture-server.ts   # listens on :7777

# 3. Provision a fixture
curl -X POST http://localhost:7777/fixture/provision \
     -H 'Content-Type: application/json' \
     -d '{"fixture_type":"small"}'

# 4. Poll until ready
curl http://localhost:7777/fixture/provision-status

# 5. Export credentials for E2E tests
curl 'http://localhost:7777/fixture/export-playwright?fixture_id=active&base_url=http://localhost:3000'
```

### 2. Snapper VM (remote fixture host)

On a shared fixture-serving VM (e.g. `snapper.wootmath.com`), fixture-serve runs as a systemd unit and registers itself with the fixture-admin UI:

```typescript
new FixtureServer({
    port: 7777,
    service_name: 'saga_api-*',
    health_url: 'http://localhost:3000/health',
    mongo_uri: 'mongodb://localhost:27018',
    db_name: 'saga_test',
    site_url: 'https://snapper.wootmath.com',
    default_profile: 'iam-pgm-small',
    admin_register_url: process.env.FIXTURE_ADMIN_URL,   // self-register on boot
    controllers: [SagaFixtureController],
});
```

Remote test orchestration then calls:

```bash
curl -X POST https://snapper.wootmath.com/fixture/provision \
     -H 'Content-Type: application/json' -d '{"fixture_type":"iam-pgm-small"}'
```

### 3. CI / ephemeral test runs

In CI, each job gets its own compose stack + fixture-serve instance, torn down at the end:

```yaml
- name: Bring up test infra
  run: npx infra-compose up --profile small

- name: Start fixture-serve
  run: node ./scripts/fixture-server.js &    # same config as local, port 7777

- name: Provision and run tests
  run: |
    curl -X POST localhost:7777/fixture/provision -d '{"fixture_type":"small"}'
    until curl -s localhost:7777/fixture/provision-status | grep -q '"ready":true'; do sleep 2; done
    pnpm test:e2e
```

### 4. Adopting as a library in a new service

Subclass `AbstractFixtureController` once per service. The minimum contract is `fixtures_dir` + `fixture_types`; override `role_mappings` and `suite_roles` to opt into credential export:

```typescript
import { AbstractFixtureController, FixtureServer, type FixtureTypeDefinition } from '@saga-ed/fixture-serve';
import { Controller } from 'routing-controllers';
import { injectable } from 'inversify';

@injectable()
@Controller('/fixture')
class MyFixtureController extends AbstractFixtureController {
    get fixtures_dir() { return '/opt/my-service/fixtures'; }
    get fixture_types(): Record<string, FixtureTypeDefinition> {
        return {
            'small': { name: '5 users', est_seconds: 30 },
            'large': { name: '50 users', est_seconds: 120,
                       creator: async opts => { /* seed DB via TS */ } },
        };
    }
    get role_mappings() { return { TUTOR: ['TUTOR'], SCHOLAR: ['STUDENT'] }; }
    get suite_roles()   { return { auth: ['TUTOR', 'STUDENT'] }; }
}

await new FixtureServer({
    port: 7777,
    service_name: 'my_api-*',
    health_url: 'http://localhost:3000/health',
    mongo_uri: 'mongodb://localhost:27018',
    db_name: 'my_test_db',
    default_profile: 'small',
    compose_file: '/opt/my-service/infra/my-api.yml',  // project-specific compose
    controllers: [MyFixtureController],
}).start();
```

See [CLAUDE.md](./CLAUDE.md) for the full config surface, endpoint contracts,
provision state machine, and DI wiring.

## Related

- [`@saga-ed/infra-compose`](../../../infra/README.md) — the Docker profile-switching layer fixture-serve mounts at `/infra`
- [`@saga-ed/soa-api-core`](../api-core/CLAUDE.md) — the Express + routing-controllers base
- [`@saga-ed/soa-db`](../db/CLAUDE.md) — MongoDB connection manager + `MockMongoProvider` used in tests

## License

Internal — Saga Education.
