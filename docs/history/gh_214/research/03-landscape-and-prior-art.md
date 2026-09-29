# Research 03 — systems landscape, dependency graph, seed org, SPAs, OCLIF prior art

> Cross-cutting research for the two new requirements: run e2e against a **partial stack (N of M systems)** and for **SPAs beyond saga-dash**. Plus the existing OCLIF prior art to build on.

## ⭐ Existing OCLIF prior art — `@saga-ed/mesh-fixture-cli`

`/home/skelly/dev/soa/packages/node/mesh-fixture-cli/` — **this already exists and is the pattern to extend.**

- **OCLIF v4**, ported from commander (2026-04). Pattern strategy: `dist/commands/<topic>/<verb>.js`.
- **Topics/commands:** `snapshot:` (list/store/restore/delete/show/validate), `iam:` (create-org/create-user/add-membership/seed-from-prod-mirror), `pgm:` (create-program/create-period/enroll/…), `ads:` (seed-attendance, deferred).
- **Global flags:** `--porcelain`, `--output-json`, `--iam-url`, `--programs-url`, `--scheduling-url`, `--ads-adm-url`.
- **Base class** `src/base-command.ts` — shared `emit()` rendering JSON/porcelain/human (the triple-output pattern).
- **bin** `bin/run.js`. Storage `~/.saga-mesh/snapshots/<fixture-id>/` (per-db `pg_dump` + manifest JSON).
- Snapshot round-trip working (Phase 3 D3.3 shipped).

**Implication:** snapshot store/restore is a faster, deterministic alternative to per-service `db:seed` for some flows — relevant to "per-system seed per flow."

## pnpm workspace (where a new CLI lives)

`soa/pnpm-workspace.yaml`: `apps/{web,node,core}/*`, `packages/{web,node,core}/*`, `build-tools/*`, `infra`. Root scripts turbo-orchestrated. pnpm 9 + CodeArtifact (`co:login`). → A new CLI is a `packages/node/*` package, exactly like mesh-fixture-cli.

## Backend systems inventory (10 services)

| Service | Port | Repo path | DBs |
|---|---|---|---|
| iam-api | 3010 | rostering/apps/node/iam-api | iam_local, iam_pii_local |
| sis-api | 3100 | rostering/apps/node/sis-api | sis_db |
| programs-api | 3006 | program-hub/apps/node/programs-api | programs |
| scheduling-api | 3008 | program-hub/apps/node/scheduling-api | scheduling |
| sessions-api | 3007 | program-hub/apps/node/sessions-api | sessions |
| ads-adm-api | 5005 | student-data-system/apps/node/ads-adm-api | ads_adm_local, ledger_local |
| saga-dash | 8900 | saga-dash/apps/web/dash | — |
| connect-api | 6106 | qboard/apps/node/connectv3-api | mongo:27037 |
| connect-web | 6210 | qboard/apps/web/connectv3 | — |
| rtsm-api | 6110 | rtsm/apps/node/rtsm-api | — (stateless) |

Mesh (soa/infra): postgres:5432 (8 DBs), redis:6379, rabbitmq:5672, connect-mongo:27037.

## Service dependency graph (the key enabler for N-of-M)

| Service | Depends on | Why |
|---|---|---|
| sis-api | iam-api (S2S) | roster queries |
| programs-api | iam-api (JWT/JWKS) | verify iam_session |
| scheduling-api | iam-api (JWT/JWKS) | same |
| sessions-api | programs-api, scheduling-api (events) | event-built projections from outbox |
| connect-api | — | standalone mongo |
| connect-web | connect-api, rtsm-api (browser) | CRDT sync |
| rtsm-api | — | stateless single-node fleet |
| saga-dash | iam, programs, scheduling, sessions, ads-adm (tRPC) | all backends |
| all | postgres, redis, rabbitmq | tx, cache, async outbox |

So **"scheduling-api + sessions-api only"** transitively needs: iam-api (JWT) + programs-api (events feeding sessions) + mesh (pg/redis/rabbitmq). A dependency-resolution function over a manifest can compute this closure automatically.

**Gap:** this graph is **implicit** (code + bash comments + drift log). Nowhere is it a machine-readable manifest. Building that manifest is the linchpin of the whole effort.

## Seed-data organization

- **Mesh-level:** `soa/infra/compose/projects/saga-mesh/seed/profile-empty.sql` creates 8 DBs + roles, no data.
- **Per-service app-level (distributed):**
  - rostering scenarios: `rostering/scripts/scenarios/src/run.ts` (`program-hub.ts` = 195 users, 46 groups).
  - program-hub scenarios: `program-hub/scripts/scenarios/src/run.ts` (`programs.ts` = 9 programs, 17 periods).
  - student-data-system: `ads-adm-db/src/seed.ts` + `ads-adm-seed` bin + SQL profiles (`profile-full.sql`, `profile-small.sql`, `profile-salesforce-full.sql`).
- **Snapshot/fixture (newer):** `mesh-fixture-cli` snapshot store/restore (per-db pg_dump).
- **Shared id contract:** `@saga-ed/iam-seed-ids`, `@saga-ed/program-hub` seed-ids → deterministic UUIDs across local/preview/CI.

`up.sh --seed roster|full` is the only flow-level selector today. **Gap:** no registry mapping flow → {systems} → {seed scripts}. Seed selection is monolithic and hardcoded in bash.

## Other SPAs (beyond saga-dash)

| SPA | Path | Framework | e2e |
|---|---|---|---|
| saga-dash | saga-dash/apps/web/dash | React | Playwright (the suite above; parked default config) |
| connect-web (connectv3) | qboard/apps/web/connectv3 | Vite | none (API-level recording-smoke only) |
| qboard-web | qboard/apps/web/qboard-web | Vite | none |
| (candidates) soa/apps/web/web-client, soa/apps/web/docs | Next.js | — | unclear |

So the "other SPAs" requirement is currently **aspirational** — only saga-dash has a real e2e suite. The CLI's job is to make a *second* SPA's suite cheap to stand up: own orchestration centrally (soa), let each SPA repo contribute specs+fixtures+a flow manifest.

## Readiness assessment

**Have:** modular mesh; documented (if implicit) deps; deterministic seed-id contract; production OCLIF scaffold (mesh-fixture-cli); env-var-driven e2e.

**Need:**
1. **Machine-readable service manifest** (port, repo, health endpoint, DBs, deps, seed command) → enables partial-stack closure + verify + launch from data instead of bash arrays.
2. **Flow registry** — named flow → {required systems, seed selection, spec set/projects, lane}.
3. **Per-system seed selection** as a first-class CLI concept (vs monolithic `--seed full`).
4. **Externalized per-SPA e2e data** — specs/fixtures/flow-manifest contributed by each SPA repo; orchestration CLI in soa.
5. **A contract between the stack CLI and the e2e CLI** (e2e calls stack to bring up the computed subset, reset, seed, verify).

## Key paths for implementation
- OCLIF template: `soa/packages/node/mesh-fixture-cli/src/{base-command.ts, commands/}`, `bin/run.js`, `package.json`.
- Service roster: `soa/tools/synthetic-dev/README.md` (table) + `up.sh` (arrays).
- Mesh: `soa/infra/compose/projects/saga-mesh/seed/profile-empty.sql`.
- Seed scenarios: `rostering/scripts/scenarios/src/run.ts`, `program-hub/scripts/scenarios/src/run.ts`.
- e2e config: `saga-dash/apps/web/dash/playwright.stack.config.ts`.
