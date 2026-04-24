# Adoption guide

Four contexts in which you'd adopt `@saga-ed/infra-compose`, with copy-paste starting points for each.

## 1. Local dev workstation

Day-to-day backend dev — one project at a time, quick profile flips.

```bash
cd ~/dev/soa/infra          # or wherever infra-compose lives

# First-time setup: nothing needed. .env.defaults ships with sensible ports.
# Optional: create ~/.fixtures/.env for your personal overrides (survives npm install -g).

# Start saga-api (mongo + mysql) with the default "small" profile
make up PROJECT=saga-api

# Switch to "basic" profile — first time seeds, subsequent times ~5s
make switch PROJECT=saga-api PROFILE=basic

# Open a shell for inspection
make mongo-shell     # uses the 27018 offset port automatically
make mysql-shell
make psql-shell

# Wipe the current profile's volumes and re-seed (other profiles untouched)
make reset PROJECT=saga-api PROFILE=basic

# Stop everything (volumes preserved)
make down PROJECT=saga-api
```

**Tip:** if another project is already running on the default ports, `make up` runs a pre-flight port check and prints the exact `docker stop` / `docker compose down` commands to resolve the conflict.

## 2. Snapper VM (remote fixture host)

On a shared fixture-serving VM like `snapper.wootmath.com`, infra-compose is usually driven from an Express API (fixture-serve or a hand-rolled router) rather than the CLI.

```javascript
import express from 'express';
import { create_router } from '@saga-ed/infra-compose/router';

const app = express();
app.use(express.json());

app.use('/infra', create_router({
    compose_file: '/opt/saga-api/infra/saga-api.yml',       // project-specific
    on_after_switch: async () => {                           // reconnect DB + restart service
        await reconnect_mongo();
        await exec_promise('sudo systemctl restart saga_api-*');
    },
    on_after_reset: async () => { /* same */ },
}));

app.listen(7777);
```

Or just use [`@saga-ed/fixture-serve`](../../packages/node/fixture-serve/README.md), which wraps this and adds fixture-provisioning endpoints on top.

Operators drive it via HTTP:

```bash
# Switch to a particular snapshot profile
curl -X POST https://snapper.wootmath.com/infra/switch \
     -H 'Content-Type: application/json' -d '{"profile":"e2e-2026-04"}'

# Reset a profile's volumes
curl -X POST https://snapper.wootmath.com/infra/reset \
     -H 'Content-Type: application/json' -d '{"profile":"e2e-2026-04"}'

# Enumerate available profiles
curl https://snapper.wootmath.com/infra/profiles
```

## 3. CI / ephemeral test runs

Each CI job gets its own compose stack. Two patterns:

**Pattern A: CLI + Make targets (ephemeral, simplest).**

```yaml
# .github/workflows/e2e.yml
- name: Bring up test infra
  run: |
    cd infra
    make up PROJECT=saga-api PROFILE=ci-seed
    # make up blocks until init containers exit (profile is seeded)
- name: Run E2E suite
  run: pnpm test:e2e
- name: Tear down
  if: always()
  run: cd infra && make down PROJECT=saga-api
```

**Pattern B: HTTP-driven reset between test batches (repeatable DB state).**

```javascript
// test-harness setup — runs before each suite
beforeAll(async () => {
    await fetch('http://localhost:7777/infra/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: 'e2e-suite-auth' }),
    });
});
```

Pattern B requires a fixture-serve (or equivalent) process; Pattern A works with only the CLI.

## 4. External repo using infra-compose as an npm package

When your repo lives outside soa and wants to consume infra-compose's Docker templates:

```bash
# Install the package
pnpm add @saga-ed/infra-compose

# Reference templates from your own compose file
```

```yaml
# my-repo/docker-compose.yml
include:
  - path: node_modules/@saga-ed/infra-compose/compose/services/mongo/compose.yml
  - path: node_modules/@saga-ed/infra-compose/compose/services/redis/compose.yml

services:
  my-app:
    build: .
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
```

```bash
# Start via plain docker compose — no CLI needed
SEED_PROFILE=small docker compose up -d
```

Or drive it programmatically:

```javascript
import { up, switch_profile, snapshot } from '@saga-ed/infra-compose';

await up({
    profile: 'small',
    compose_file: './docker-compose.yml',
});
```

**Migration note (1.0.0):** external consumers who were on 0.x must update their `include:` paths — `services/` moved under `compose/services/`. Change `node_modules/@saga-ed/infra-compose/services/…` to `node_modules/@saga-ed/infra-compose/compose/services/…`.

## Providing custom seed data

All four contexts support project-specific seeds via the `--seed-dir` option (CLI) or `seed_dir` option (JS API):

```bash
npx infra-compose up --profile small --seed-dir ./my-seeds
```

The init containers pick up `./my-seeds/mongo/`, `./my-seeds/mysql/`, `./my-seeds/postgres/` as overlay seed sources alongside the bundled profile files. Useful when you want the canonical `small` schema plus your project's domain fixtures.
