# Deep readiness adoption runbook

Per-service steps to move a Node service from hand-rolled `/health/ready` (or 0.1.x `mountReadinessRoutes`) to `createDeepReadiness` (soa-health >= 0.4.0). Semantics live in [deep-readiness.md](deep-readiness.md); this is the checklist. Reference adoption: rostering#1814 (authz-api, `apps/node/authz-api/src/readiness.ts`).

One PR per service. Do not bundle a soa-observability bump in the same PR: the 0.3.1 `/health*` span drop is verified on its own.

## 0. Inventory first

Before writing the manifest, record for the service:

| Item | Where to look |
|---|---|
| Every client the process opens (Postgres/Prisma, Mongo, Redis, RabbitMQ publish + consume, OpenFGA, AWS, HTTP upstreams) | `main.ts`, DI bindings |
| Current ALB TG `HealthCheckPath` per stanza (dev, each prod colour, `-main` live stack) | `infra/<svc>/samconfig.yaml`, `routing-template.yaml` |
| ECS container `healthCheck` path, `StartPeriod`/`Interval`/`Retries`, `HealthCheckGracePeriodSeconds` | `service-template.yaml` |
| Dockerfile `HEALTHCHECK` path | `Dockerfile` |
| D13 colour-gated work (consumers, outbox relay, schedulers) | `deploy-color/`, `soa-deploy-color` usages |
| Secrets a probe needs (tokens, API keys) and whether the PR-preview workflow passes them | `pr-preview-<svc>.yml` `service-parameter-overrides-json` |

If the ALB check is plain `/health` (always 200) today, moving it to `/health/ready` is a NEW gate, not a refactor: flag it in the PR and vet with a dev deploy before prod.

## 1. Code

1. Bump `@saga-ed/soa-health` to `^0.4.0` (package.json + lockfile). From 0.1.x, read the 0.3.0 breaking note in the [README](../README.md): `env` is gone, pass `identity`.
2. Add `src/readiness.ts` exporting `READINESS_BOOT_TIMEOUT_MS` (60 000 in the pilot) and a manifest builder over `declareDependencies` / `dep(...)`. Per dependency:
   - `criticality` always; `scope: 'shared'` for anything every task shares (DBs, broker, FGA). `scope: 'task'` only for a genuinely per-task sidecar: it turns post-first-success failures into 503.
   - `whenAbsent: 'fail'` when a null client must never be ready, local included.
   - Postgres: `kind: 'prisma'` (or `'postgres'`), plus `freshProbe: pgFreshProbe(createFreshPgClient)`. The factory builds an UNPOOLED `pg.Client` and mints the password/IAM token at call time (see `createAuthzFreshPgClient` in rostering `db-init.ts`).
   - `schemaProbe` (core-table `findFirst({ select: { id: true } })`) runs on `/health/deep` only; never put a table read in `probe` or a boot path. Previews run Migrate after the service deploy, so a boot-time table read crash-loops fresh DBs.
   - Custom probes return `{ ok: true }` or `{ ok: false, reason }` (closed `ProbeReason` enum). Use `boot: 'skip'` for anything that only starts after `listen()` (consumers, projection catch-up).
3. In `main.ts`:
   - `createDeepReadiness({ manifest, bootTimeoutMs, onProbeError, identity })`, then `mountDeepReadiness(app, readiness)` BEFORE `mountHealthRoutes` (first route wins).
   - `await readiness.boot()` before `listen()`; log `verdict`/`bootMode`; rethrow on failure so the circuit breaker rolls back.
   - `readiness.start()` after boot; `readiness.stop()` in shutdown.
   - Delete the old `/health/ready` handler and its probe helpers.
4. Unit test the manifest (pilot: `src/__tests__/readiness.test.ts`): each declared dependency resolves a probe, null clients fail, colour-gated probes follow section 3.

## 2. Template and Docker

| Change | Value |
|---|---|
| New `ContainerHealthCheckPath` param, default `/health/live`; container `healthCheck` uses it | Liveness only; never a dependency probe |
| Dockerfile `HEALTHCHECK` | `/health/live` |
| `ReadinessBoot` param (`block`/`warn`/`open`, default `block`) → `READINESS_BOOT` env | See section 4 |
| Container `StartPeriod + Retries x Interval` | `> READINESS_BOOT_TIMEOUT_MS` |
| `HealthCheckGracePeriodSeconds` | `>= bootTimeout + first probe + HealthyThreshold x Interval + margin`; 90 for a 60 s boot timeout (30 is too short) |
| ALB TG `HealthCheckPath` | `/health/ready` on dev and every prod colour TG |

Prod deploys skip the routing stack: a TG `HealthCheckPath` change in a prod stanza is a manual `routing-prod-<colour>` sam deploy. A `-main` live stack whose TG has no registered targets is inert; leave it.

If a boot probe needs a secret, the PR-preview workflow must pass it in `service-parameter-overrides-json` (authz-api previews 401'd on OpenFGA until `OpenfgaApiTokenSecretArn` was wired). Otherwise `boot()` never passes in the preview.

## 3. Blue/green (D13) colour-gated work

An idle colour pauses its consumers and outbox relay by design. Readiness must treat "paused because the gate is inactive" as ok, or the idle colour never goes TG-healthy and the flip gate blocks.

- Consumer probe: ok when consuming, or paused while `gate.isActive()` is false; not ok when disconnected, or paused while the gate is active. Port the service's existing rule as-is (transcripts-api: `health/readiness.ts` `consumerReadiness`).
- Relay probe: ok unless the relay latched a failure. A gate pause is not a failure.
- Declare both `boot: 'skip'` when they start after `listen()`.

After first success these degrade (200 + metric) rather than 503, so a broker blip no longer pulls every task.

## 4. `READINESS_BOOT` during an outage

`block` gates `listen()` on first success. To ship a fix while a shared dependency is down, deploy with `ReadinessBoot=warn` (stays 503 until a first success) or `open` (enters the TG degraded). The deploy workflow does not pass `ReadinessBoot`, so an override persists across deploys until one sets `ReadinessBoot=block`: reset it after the incident.

## 5. Vetting and rollout

1. Dev deploy; `curl /health/ready` and `/health/deep`; confirm `bootMode: block` and every critical dependency `ok`. Check the boot log line.
2. Kill-test locally (`ss` stack or a sandbox, never shared dev): stop a dependency after first success, expect 200 `degraded` and the metric, not 503.
3. Prod: deploy to the idle colour, smoke `/health/deep` on the idle colour, flip. Record the rollback image in the PR.
4. Confirm the DD pg-auth and 5xx-guard monitors (iac#939/#948) cover the service.

Order: services with no prior gate first, iam/sis last (they keep the 0.1.x Redis-503 behaviour until they migrate).
