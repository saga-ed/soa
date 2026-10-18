# Deep readiness (soa#517, M3) - design

Status: DRAFT for design review. Types only: `src/deep-readiness.types.ts`. Part of hipponot/iac#897.

## 1. Problem and current state

Readiness is hand-written per service and shallower than the failures it should catch.

| Service | Today |
|---|---|
| authz-api | `/health/ready` = `!!authzPrismaClient` (client non-null); prod TGs probe plain `/health` (`iam-api/samconfig.yaml:611,636,664,690`) |
| ledger-api | `/health/ready` = in-memory `isPostgresConnected` / `isRabbitConnected` flags |
| iam/sis (rostering#1684) | Best current shape: `createDbReadiness` background ping (cached), `awaitDbAtBoot`, `redis.isReady`, drain, and a separate `/health/deep` doing real I/O (schema probe, Redis PING, KMS JWKS) |
| program-hub, saga-dash BFF | `mountHealthRoutes` / ad-hoc `/health` |

soa-health 0.1.x already has the right primitives (timeout, coalesced cached deep route, drain, build identity). Gaps this design closes:

1. The set of probes is written by hand, so nothing forces a declared dependency to have one.
2. The TG path (`/health/ready`) in rostering#1684 only reads cached DB state; Redis is `isReady` (connection flag), KMS is not checked at all outside `/health/deep`. "Deep" is a separate, optional path nobody routes traffic on.
3. No critical/optional distinction, no machine-readable schema, no CI guard.
4. DB-specific (`createDbReadiness`).

## 2. Dependency declaration API

```ts
const manifest = declareDependencies({
  service: 'authz-api',
  dependencies: [
    { name: 'authzDb', kind: 'postgres', criticality: 'critical', client: () => prisma,
      schemaProbe: (p) => p.tuple.findFirst({ select: { id: true } }) },
    { name: 'openfga', kind: 'openfga', criticality: 'critical', client: () => fga },
    { name: 'redis',   kind: 'redis',   criticality: 'optional', client: () => redisClient, whenAbsent: 'skipped' },
  ],
});
```

- `client` is a thunk returning the REAL instance the app uses (Prisma client, node-redis client, OpenFGA SDK client, S3/SSM client with the app's credential provider and agent). The runner never constructs a connection. This is what makes credential-mechanism, CA, DNS and SG deltas visible (C3/C5/C6). A thunk, not a value, so DI containers and late init work and a null client is representable.
- `kind` selects a built-in probe adapter; `probe` overrides it (required for `custom`). Adapters take the typed client structurally (no hard dependency on `pg`, `redis`, `@openfga/sdk`, `@aws-sdk/*`; peer/optional types only), so the package keeps its zero-runtime-dependency shape.

| kind | Default probe via the real client |
|---|---|
| postgres | `SELECT 1` (Prisma `$queryRaw` / pg `query`); `schemaProbe` for a core-table read |
| mongo | `db.command({ping:1})` |
| redis | `PING` expecting `PONG` (not `isReady`, which is in-memory state) |
| rabbitmq | channel-level check on the app's connection (`connection.isOpen` + a passive `checkExchange` on a declared exchange); never open a new connection |
| http | `HEAD`/`GET <healthUrl>` through the app's own fetch wrapper (same agent/CA/DNS), 2xx = ok; default target is the upstream's `/health/live`, never its `/health/ready` (avoid cascading readiness) |
| openfga | `readAuthorizationModel` or a cheap `check` against the configured store, via the SDK client |
| aws-s3 / aws-ssm / aws-kms | `HeadBucket` / `GetParameter` on a declared canary name / `DescribeKey`, via the app's credential chain (proves the role, not just reachability) |
| custom | caller-supplied |

Absent client: `whenAbsent: 'skipped'` (ready, state `skipped`) or `'fail'`. Default `fail` for `critical` when `env` is `dev`/`prod`, `skipped` for `local`/`ci`. This removes the "null client = disabled = ready" silent-green pattern in a deployed environment.

CI guard: `assertManifestComplete(manifest, { discover })` in a service unit test fails when (a) any declaration has no resolvable probe (kind `custom` without `probe`), (b) names collide, or (c) a client name in `discover` (a plain string list the service maintains next to its DI bindings, or generated from them) is absent from the manifest. (c) is the "declared dependency has no probe" inverse and is the only part that needs per-service discipline; see open question 3.

## 3. Semantics: live vs ready vs deep vs boot

| Path | Consumer | Behaviour |
|---|---|---|
| `/health/live` | ECS container healthCheck, ad-hoc curl | Always 200, including while draining; process-alive only. No dependency state. Never restarts a task for a dependency outage (that would amplify an outage into a restart storm). |
| `/health/ready` | ALB target group | Reads the cached state produced by background active probes. Zero dependency I/O per request. 200 when verdict is `ready` or `degraded`; 503 when `not_ready`, `starting`, or `draining`. |
| `/health/deep` | deploy smoke, idle-colour smoke, `ss`, twin, humans | Runs fresh active probes including `schemaProbe`, rate-limited and coalesced (section 4). Same report document. Never a TG path. |
| boot self-test | `createDeepReadiness().boot()` before `listen()` | Runs the same probe set with retry until `bootTimeoutMs`; rejects so the process exits before taking traffic and the ECS circuit breaker rolls back. Includes `schemaProbe` only when `boot: 'block'` and the migration ordering allows it (rostering#1684 note: migrations run after the new task boots, so schema probes are deep-only by default). |

Critical vs optional:

- `critical` failing for `failureThreshold` consecutive probes (default 2) or stale beyond `staleAfterMs` => `not_ready` (503), pulled from the TG.
- `optional` failing => verdict `degraded`, HTTP 200, reported in the body and a metric/log, never pulls the task. Use for dependencies the service survives without (cache, optional enrichment).
- Rule of thumb: pull a task from the TG only when removing it helps. A shared dependency that is down fails every task identically, so pulling all tasks converts a partial outage into a total one (an empty TG still serves 503s, but also kills the 5xx-vs-no-target distinction and blocks deploys). Two mitigations: (a) the deploy health check uses `/health/deep` as in rostering#1684, with a dispatch-time fallback to `/health/ready` to ship a fix during an outage; (b) an ALB with zero healthy targets fails open to all targets, which we rely on and document rather than fight.
- Which to mark critical is a per-service decision made in the manifest, reviewed in the PR. Default for `postgres` and `openfga` is `critical`; for `redis`, `http`, `aws-*` there is no default, the author must state it (type-enforced: `criticality` is required).

State machine per dependency: `starting` (no success yet) -> `ok` -> `failing` (>= threshold) -> `ok`; `stale` when no success inside `staleAfterMs` (catches expired RDS IAM tokens, as `createDbReadiness` does today); `skipped`.

## 4. Timeouts, caching, rate limiting (probe load on dependencies)

Invariants, all enforced by the runner so adopters cannot violate them:

1. TG-facing `/health/ready` performs no dependency I/O. Load on a dependency from readiness = tasks x (1 / intervalMs), independent of ALB probe rate, number of ALB nodes, and any scraper. Example: 30 tasks x 1 probe/15s = 2 qps per dependency across the fleet.
2. One in-flight probe per dependency; probes never overlap (as `createDbReadiness`).
3. `observe(name, 'success'|'failure')` lets real traffic (a Prisma extension, an axios interceptor) refresh state and suppress the next active probe, so busy services add near-zero probe load. Failures observed from traffic count toward the threshold but cannot by themselves clear a `failing` state; only an active probe can.
4. Per-probe hard timeout (default 2000ms) with `AbortSignal` passed to the probe so a hung socket is released, not just abandoned. Timeout < ALB `HealthCheckTimeoutSeconds` (4s in the iam template); since `/ready` is cache-only it answers in microseconds regardless.
5. `/health/deep`: result cached `deepCacheMs` (default 5s), concurrent callers coalesced, and a global `minProbeGapMs` per dependency shared with the background loop, so an unauthenticated flood cannot exceed ~1 probe/second/dependency/task.
6. Jitter the background interval (+-20%) so a fleet restarted together does not probe in lockstep.
7. Probes must be cheap and side-effect free (reads only; no writes; no queue publishes; no token-minting calls that have cost or quota).

Fail-stale-safe: if the event loop is blocked, the cache stops refreshing and `staleAfterMs` turns the verdict `not_ready`; this keeps the old `createDbReadiness` property.

## 5. TG health path, ECS and blue/green

- TG `HealthCheckPath=/health/ready`, container healthCheck `/health/live` (the issue's "wired separately"). Today the iam/authz service templates feed the same `HealthCheckPath` parameter to both the TG and the container `node -e fetch(...)` check (`service-template.yaml:1200`), so a dependency blip would restart containers. Change: add `ContainerHealthCheckPath` (default `/health/live`) to the service template; TG keeps `HealthCheckPath`. Prod samconfigs still on `/health` move to `/health/ready` as part of adoption (iac change, one PR per service).
- Circuit breaker: the new task fails `boot()` or never reaches TG-healthy => deployment fails => `DeploymentCircuitBreaker.Rollback` rolls back. This is the intended C7/C11 catch: the credential/CA/DNS/SG/version delta that previously gave a green rollout now fails at boot or first probe. TG `HealthyThresholdCount` x interval is the minimum time to healthy; `HealthCheckGracePeriodSeconds` must cover `bootTimeoutMs` plus first probe (service template currently 30s vs a 60s default boot deadline, so either lower `bootTimeoutMs` to ~25s in ECS or raise the grace period; open question 5).
- Steady state: `UnhealthyThresholdCount: 5` x 5s interval in the routing template, plus our own `failureThreshold: 2` x 15s probe interval, means roughly 30-55s from dependency failure to TG removal. Acceptable; documented so nobody tunes one without the other.
- Blue/green idle colour: smoke hits the idle colour via the preview header on `/health/deep` and consumes the JSON (`verdict`, `build.colour`, per-dependency state). The idle colour is autoslept (ph#1003 wake) so `starting` is a normal verdict right after wake; smoke retries with backoff until `ready`/`degraded` or deadline. `build.colour` continues to prove WHICH colour answered. The flip precondition becomes `verdict in {ready, degraded}` with an explicit allow-list of degraded optional dependencies, not just HTTP 200.
- Draining: unchanged (`isDraining` => 503 `draining` on `/ready`, `/live` stays 200).

## 6. Machine-readable report

One versioned document (`schema: 'saga.readiness/v1'`) from `report()` and `deepReport()`; HTTP status mirrors `verdict`. See `ReadinessReport` in the stubs. Fields: `verdict` (`ready|degraded|not_ready|starting|draining`), `httpStatus`, `build` (colour, version, environment, deployedAt, from existing `buildIdentity()`), `generatedAt`, `summary` counts, and at internal detail per-dependency `{ name, kind, criticality, state, reason, latencyMs, lastSuccessAgeMs, consecutiveFailures, level }`.

Consumers read the same shape: `ss` verify (stage S, local deps), the twin (stages B/D), M4 idle-colour smoke (stage I). Contract: additive changes only inside `v1`; a breaking change is `v2` served alongside for one release. A small Zod/JSON-Schema artifact is published from the package so consumers validate instead of hand-parsing (open question 4).

`reason` is a closed enum, not free text (security below). The legacy `checks: Record<string, {ready, detail}>` shape is emitted alongside in `v1` during migration so existing smoke scripts keep working.

## 7. Security

- Responses never contain: connection strings, hostnames/IPs of dependencies, usernames, error messages from the dependency driver, stack traces, SQL, row data, token or key identifiers, parameter or bucket/queue names beyond the declared logical `name`. Driver errors are mapped to the closed `ProbeReason` enum in the runner; raw errors go to the service logger only (with the existing redaction).
- Two detail levels. `public` (default; what an unauthenticated caller, including the ALB and the internet if the route is reachable, receives): `verdict`, `httpStatus`, `build`, `summary` counts. No dependency names or states. `internal`: full per-dependency list. Granted only when `authorizeInternal(req)` returns true (default deny); recommended rule: request carries an internal-network marker AND a shared deploy-smoke bearer (SSM-sourced) OR arrives on the VPC-internal ALB listener. This is deliberately injectable: the library has no auth dependency. Idle-colour smoke and `ss` use the internal level.
- Today's `/health/ready` and `/health/deep` in 1684 expose dependency names and `detail` strings unauthenticated; moving to `public` by default is a behaviour change for any script parsing `checks` (migration step 3 below).
- `/health/deep` stays unauthenticated-reachable at `public` level, so its worst case is the rate-limited probe cost in section 4 and a boolean-ish outcome; internal detail needs authorisation.
- No probe may write, publish, or read PII rows. Schema probes select a primary key only, `findFirst({ select: { id: true } })`, as 1684 does.

## 8. Migration path

1. Ship `createDeepReadiness`/`mountDeepReadiness` additively in soa-health 0.2.0. Old `mountReadinessRoutes`, `mountHealthRoutes`, `createDbReadiness`, `awaitDbAtBoot` stay and are reimplemented on the new runner (a `postgres` dependency), no breaking change.
2. Pilot: authz-api (client-non-null today; evidence `authz-api/src/main.ts:205`). Manifest: authz-db (postgres, critical, schema probe), openfga (critical), Redis if used (optional). Boot self-test fails closed. Prod TG moves `/health` -> `/health/ready` and container check -> `/health/live`, dev first, then a prod blue/green deploy with idle-colour smoke (per the deploy-wave rules).
3. iam/sis (1684) migrate by replacing `mountIamHealth` with a manifest: iamDb/piiDb (postgres), redis (PING, not `isReady`), kms (aws-kms/custom, `getJwks`). Emits legacy `checks` for one release. Public/internal split lands here, with scripts updated to send the smoke credential.
4. ledger-api (postgres + rabbitmq), program-hub APIs, student-data-system APIs, saga-dash BFFs by repo. The `http` kind covers BFF -> iam-api/upstream checks.
5. Service template (`ContainerHealthCheckPath`) in rostering/iac as its own PR; lint step in the reusable CI (`assertManifestComplete` via a service unit test, then a repo-level lint that every `apps/node/*` has a manifest) once the majority adopted.
6. Deprecate the ad-hoc paths after all services adopt; remove one major later.

## 9. Trade-offs considered

- Background active probes + cache (chosen) vs probing per request: per-request is the "ALB overloads dependency" failure and makes readiness latency depend on the dependency. Cost of the chosen approach: up to ~15s staleness; mitigated by `observe()` and the deep path for smoke.
- Failing readiness on a shared-dependency outage: correct for task-local faults (bad credentials on one task, DNS, SG on a new colour: exactly the C3/C5/C6 classes) but harmful for shared outages. Mitigated by criticality, the ALB fail-open behaviour, and the dispatch-time `health-path` fallback from 1684. This is the main judgment call; see open question 1.
- Probing through the real client vs a parallel connection: the real client can be healthy while a fresh connection fails (and vice versa); we want the former because it is what serves traffic. Cost: a probe may queue behind a saturated pool; the timeout treats that as a failure, which matches user experience.

## 10. Open questions for review

1. Should a shared-dependency outage ever pull every task from the TG? Proposal: yes for `critical` after threshold, relying on ALB fail-open, with the deploy-time override. Alternative: add a `scope: 'task' | 'shared'` flag where `shared` failures only degrade.
2. Package boundaries: ship adapters inside soa-health (structural types, no deps) or as sub-path exports / peer-dependency packages (`@saga-ed/soa-health/openfga`)?
3. Completeness enforcement (c): is a hand-maintained `discover` list acceptable, or do we derive it from DI bindings / a static scan for `new PrismaClient(`, `createClient(`, etc.?
4. Publish a JSON Schema/Zod artifact for `saga.readiness/v1`, and who owns it (soa-health vs the twin/`ss` repo)?
5. Boot deadline vs ECS grace period (60s default vs 30s template): which side moves?
6. Internal-detail authorisation mechanism: bearer from SSM, internal-only listener, or both?
7. Is `degraded` -> 200 right for the idle-colour flip gate, or should flip require plain `ready`?
