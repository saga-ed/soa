# Deep readiness (soa#517, M3) - design

Status: DRAFT, review round 1 applied (HOLD resolved; see PR body checklist). Implemented in 0.2.0 under `src/deep/` (+ `schema`, `aws`, `openfga` sub-path exports). Part of hipponot/iac#897.

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
    dep({ name: 'authzDb', kind: 'postgres', criticality: 'critical', scope: 'shared',
          client: () => prisma,
          schemaProbe: (p) => p.tuple.findFirst({ select: { id: true } }) }),
    dep({ name: 'openfga', kind: 'openfga', criticality: 'critical', scope: 'shared', client: () => fga }),
    dep({ name: 'redis', kind: 'redis', criticality: 'optional', client: () => redisClient, whenAbsent: 'skipped' }),
  ],
});
```

- `client` is a thunk returning the REAL instance the app uses (Prisma client, node-redis client, OpenFGA SDK client, AWS client with the app's credential provider and agent). The runner never constructs a connection. Each entry goes through `dep<C>({...})`, which infers `C` from `client` so `probe`/`schemaProbe` are typed against the real client under `strict`; the manifest holds the type-erased result (a plain `readonly DependencyDeclaration<C>[]` would erase `C`). This is what makes credential-mechanism, CA, DNS and SG deltas visible (C3/C5/C6). A thunk, not a value, so DI containers and late init work and a null client is representable.
- `kind` selects a built-in probe adapter; `probe` overrides it (required for `custom`). Adapters take the typed client structurally (no hard dependency on `pg`, `redis`, `@openfga/sdk`, `@aws-sdk/*`; peer/optional types only), so the package keeps its zero-runtime-dependency shape.

| kind | Default probe via the real client |
|---|---|
| postgres | `SELECT 1` (Prisma `$queryRaw` / pg `query`); `schemaProbe` for a core-table read. Prisma has no `AbortSignal` on `$queryRaw`, so the runner RACES the call against the timeout; the query is abandoned, not cancelled, and keeps its pool connection until it settles. Hence the one-in-flight rule (section 4) and the pool-acquire rule (section 3) |
| mongo | `db.command({ping:1})` |
| redis | `PING` expecting `PONG` (not `isReady`, which is in-memory state) |
| rabbitmq | `connection.isOpen` plus a passive `checkExchange` on a declared exchange, on a DEDICATED probe channel owned by the adapter (a channel error closes the channel; the app's publish/consume channels must never be the probe channel). The channel is opened on the app's existing connection, never a new connection |
| http | `HEAD`/`GET <healthUrl>` using the app wrapper's RAW fetch (same agent/CA/DNS) but bypassing its circuit breaker and retries: a probe must not open/close the app's breaker, count against its retry budget, or be short-circuited into a false failure. The wrapper must expose a `raw`/`probeFetch` handle. Default target is the upstream's `/health/live`, never its `/health/ready` (avoid cascading readiness) |
| openfga | `readAuthorizationModel` or a cheap `check` against the configured store, via the SDK client (sub-path `/openfga`, optional peer dep) |
| aws-* | NO generic default. The author passes the cheapest operation the app's task role ALREADY performs in normal operation (e.g. the JWKS `GetPublicKey` path for KMS, `GetParameter` on a parameter the app reads, an S3 key the app reads). `DescribeKey`/`HeadBucket` are not defaults because the task role may not hold them, which would turn an IAM gap in the probe itself into a permanent 503 (sub-path `/aws`, optional peer deps) |
| custom | caller-supplied |

Absent client: `whenAbsent: 'skipped'` (ready, state `skipped`) or `'fail'`. The environment comes from the `identity` option (soa-env's resolved `EnvIdentity`). Only `identity.account.kind === 'local'` (`SAGA_LOCAL=1`) allows the `skipped` default; anything else, including no identity, is treated as DEPLOYED and fails closed (default `fail`). It never falls back to `local`, and no raw env var is read. Sandbox lanes (`twin`, `mirror`) are not `EXEC_ENV` values: they are read from the LANE identity of hipponot/iac#898 (field/contract to be bound once that lands; this design has not read the contract) and only select lane-specific allowances, never relax the unknown-env rule. This removes the "null client = disabled = ready" silent-green pattern.

CI guard: `assertManifestComplete(manifest, { discover })` in a service unit test fails when (a) any declaration has no resolvable probe (kind `custom` without `probe`), (b) names collide, or (c) a client in the discovery source is absent from the manifest. Pilot: a hand-kept `discover` string list next to the DI bindings is accepted. Fleet-wide: soa client providers (PostgresProvider, redis-core, rabbitmq, ...) self-register in a process-level registry and `assertManifestComplete` diffs that registry against the manifest, so no list is hand-maintained. (c) is the inverse of "declared dependency has no probe".

## 3. Semantics: live vs ready vs deep vs boot

| Path | Consumer | Behaviour |
|---|---|---|
| `/health/live` | ECS container healthCheck, ad-hoc curl | Always 200, including while draining. Process-alive only. NOT a restart-storm guard: see section 5, ECS replaces tasks on the ELB check regardless of it. |
| `/health/ready` | ALB target group | Cache only, zero dependency I/O per request. 200 for `ready` and `degraded`; 503 for `not_ready`, `starting`, `draining`. |
| `/health/deep` | deploy smoke, idle-colour smoke, `ss`, twin, humans | Fresh active probes incl. `schemaProbe`, rate-limited and coalesced (section 4). Same report. Never a TG path. |
| boot self-test | `boot()` before `listen()` | Same probe set, retried until `bootTimeoutMs`; rejects so the process exits before taking traffic. See override below. |

### Verdicts

- `ready`: every dependency `ok`/`skipped`.
- `degraded`: the task serves traffic (HTTP 200) but at least one dependency is not `ok`: an `optional` dependency failing, a `critical` dependency failing AFTER its first success (unless declared `scope: 'task'`), or a pool-acquire timeout is present. `observe()` failures never appear here: they are metric-only. Always accompanied by a metric/log so it is alertable; it never pulls the task.
- `not_ready`: 503, the task is removed from the TG.
- `starting`: 503, a `critical` dependency has not yet had its first success.
- `draining`: 503, SIGTERM received.

### Gating rule (confirmed: owner, 2026-10-25)

1. Until a critical dependency's FIRST success (boot, or `starting` verdict), it gates readiness: no success, no traffic.
2. After first success, EVERY failure is treated as `shared` by default, `auth`/`tls`/`dns` included: `degraded`/200 plus a metric, because pulling every task cannot help and, per section 5, causes replacement storms. Exactly two cases yield 503: (a) a stale cache, i.e. a blocked event loop that stopped refreshing within `staleAfterMs`; (b) a dependency explicitly declared `scope: 'task'` (opt-in, for dependencies that are genuinely per-task, e.g. a local sidecar). Peer-divergence detection (this task fails while its peers pass) is out of scope.
   Asymmetry behind the default: a false 503 empties the whole fleet; a false 200 errors roughly 1/N of requests on the bad task. We choose the cheaper error.
3. `optional` failures only degrade.

Never counted toward 503 (neutral, degrade + metric only): pool-acquire timeouts (`pool_exhausted`: the probe could not even obtain a connection; that is load, and failing readiness on load sheds capacity at the worst moment and starts a spiral) Failures reported through `observe()` are METRIC-ONLY: they never change the verdict, not even to `degraded`, otherwise user-caused errors would flake the idle-colour flip gate. Only an active probe that reached the dependency can drive `failing`.

`criticality` is REQUIRED on every declaration (no per-kind default; the earlier "default critical for postgres" is dropped as contradictory). `scope` is required for `critical` declarations.

Per-dependency state machine: `starting` -> `ok` -> `failing` (>= `failureThreshold`, default 2) -> `ok`; `stale` (no probe completion or traffic success within `staleAfterMs`: a blocked loop, not a dependency fault; a pooled ping keeps a warm connection and does NOT catch expired RDS IAM tokens, use `freshProbe`, section 4); `skipped`.

### Boot override for shipping a fix during an outage

`boot()` blocking on a down dependency means a replacement task never listens, and the circuit breaker rolls back the very deploy that carries the fix. `READINESS_BOOT=block|warn|open`, one dispatch-settable task env var wired through the deploy workflow input and service template: `block` (default) = boot gates; `warn` = `boot()` logs and continues, but the task still reports 503 on `/ready` (`starting`) until a first success; `open` = `warn` plus the first-success gate off, so the task enters the TG with a down dependency (state `degraded`). `open` NEVER lifts the stale-cache/blocked-event-loop 503. The mode is reported as `bootMode` so smoke and humans see a task is running unguarded. The workflow input defaults to `block`, so the next ordinary deploy resets any override. There is no separate gate knob. Note that rostering#1684's `health-path` dispatch input only changes the smoke URL; it does not stop `boot()` from failing, so it is not this mitigation.

## 4. Timeouts, caching, rate limiting (probe load on dependencies)

Invariants, all enforced by the runner so adopters cannot violate them:

1. TG-facing `/health/ready` performs no dependency I/O. Load on a dependency from readiness = tasks x (1 / intervalMs), independent of ALB probe rate, number of ALB nodes, and any scraper. Example: 30 tasks x 1 probe/15s = 2 qps per dependency across the fleet.
2. One in-flight probe per dependency; probes never overlap (as `createDbReadiness`).
3. `observe(name, 'success'|'failure')` lets real traffic (a Prisma extension, an axios interceptor) refresh state and suppress the next active probe, so busy services add near-zero probe load. Traffic-observed failures are metric-only and never move state or verdict; only an active probe can drive `failing` or clear it.
4. Per-probe hard timeout (default 2000ms). Where the client supports it (fetch, node-redis, AWS SDK v3) an `AbortSignal` releases the socket; where it does not (Prisma `$queryRaw`) the call is raced and abandoned, and the one-in-flight rule is what bounds the leak to one pooled connection per dependency per task. Timeout < ALB `HealthCheckTimeoutSeconds` (4s in the iam template); since `/ready` is cache-only it answers in microseconds regardless.
5. `/health/deep`: result cached `deepCacheMs` (default 5s), concurrent callers coalesced, and a global `minProbeGapMs` per dependency shared with the background loop, so an unauthenticated flood cannot exceed ~1 probe/second/dependency/task.
6. Probes use the app's pools, so a pool-acquire timeout is classified `pool_exhausted` and is neutral (section 3). Probes must not retry.
7. Jitter the background interval (+-20%) so a fleet restarted together does not probe in lockstep.
8. Probes must be cheap and side-effect free (reads only; no writes; no queue publishes; no token-minting calls that have cost or quota).

### `freshProbe` (soa#504)

Pooled probes reuse a warm connection, so they cannot see credential expiry that only affects NEW connections (RDS IAM token cliff: SQLSTATE 28000 / "PAM authentication failed", ads-adm-api prod, 2026-08-05). Declare `freshProbe` to open a new connection with current credentials, run a trivial query and close it; `pgFreshProbe(() => new Client(...))` does this for `pg`. The factory must mint the token/password at call time.

- Cadence: `freshIntervalMs` (default 300000, +-20% jitter), independent of `intervalMs`; one in flight per dependency; same per-probe timeout; no traffic suppression. While the latest fresh outcome is a failure it re-probes at `min(freshIntervalMs, intervalMs)` so `failureThreshold` confirms and recovery lands promptly.
- State: a fresh failure is an active-probe failure (classified like any probe error, so 28000 / PAM / password failures are `auth`); it adds to the dependency's failure count against `failureThreshold`. Before first success it gates; after, it degrades (200) unless `scope: 'task'` (503).
- A pooled-probe success or `observe()` success never clears a fresh failure; only the next fresh success does. Fresh failures are tracked apart from pooled ones and the report sums both in `consecutiveFailures`.
- Boot: with `freshProbe` declared, first success needs both a pooled and a fresh success (blocking per the dependency's boot mode).
- `/health/deep` runs it too, subject to the deep cache, coalescing and `minProbeGapMs` (at most one fresh connection per gap).
- Cost: one extra connection per task per `freshIntervalMs`, held for one `SELECT 1`.

Fail-stale-safe: if the event loop is blocked, the cache stops refreshing and `staleAfterMs` turns the verdict `not_ready`; this keeps the old `createDbReadiness` property.

## 5. TG health path, ECS and blue/green

- TG `HealthCheckPath=/health/ready`; container healthCheck `/health/live` via a new `ContainerHealthCheckPath` (default `/health/live`) in the service template (today the iam/authz templates feed `HealthCheckPath` to both, `service-template.yaml:1200`). Prod samconfigs still on `/health` move to `/health/ready` per service.
- IMPORTANT, ECS replacement: past `HealthCheckGracePeriodSeconds`, ECS replaces any task that fails the ELB (TG) health check, whatever the container check says. `/health/live` therefore does NOT protect against restart storms. If a shared critical outage 503'd `/ready` on every task, ECS would kill all of them; replacements would block in `boot()`; the TG would be empty; and ALB fail-open (which applies to an existing target set, not to targets that do not exist yet) would not help. This design does not rely on fail-open. The mitigation is the gating rule in section 3: after first success, shared-dependency failures degrade (200) and cannot trigger replacement; only task-local failures can, which is exactly when replacing helps.
- Residual risk: because post-first-success failures (auth/tls/dns included) default to `shared` and degrade, a failure that is truly task-local (one task with a bad credential) keeps serving errors on about 1/N of requests until the degraded metric alerts; we accept this over the fleet-emptying cost of a false 503. There is no deploy-time containment for steady-state 503s (the circuit breaker acts only during deployments), so none is claimed.
- During a shared outage, a NEW task (deploy, scale-out) cannot pass its first-success gate and stays out of the TG; existing tasks keep serving. To ship a fix then, dispatch with `READINESS_BOOT=warn` (section 3).
- Circuit breaker: a new task that fails `boot()` or never becomes TG-healthy fails the deployment and rolls back. This is the intended C7/C11 catch for credential/CA/DNS/SG/version deltas.
- Grace period derived from ONE value, not independently tuned: `HealthCheckGracePeriodSeconds >= bootTimeoutMs + firstProbe + HealthyThresholdCount x HealthCheckIntervalSeconds + margin`. With the iam routing template (Healthy 2 x 5s) and bootTimeout 60s that is about 60 + 2 + 10 + margin = 80s, versus 30s today, so the template change is required with adoption (or bootTimeout lowered). The container check keeps `StartPeriod + Retries x Interval` above `bootTimeoutMs`, so the container check cannot fail while `boot()` is still legitimately retrying. A lint in the service template derives both from the one `ReadinessBootTimeoutSeconds` parameter.
- Steady state: TG `UnhealthyThresholdCount: 5` x 5s plus `failureThreshold: 2` x 15s probe gives roughly 30-55s from a task-local failure to TG removal.
- Blue/green idle colour: smoke calls the idle colour (preview header) on `/health/deep` at `internal` detail and consumes the JSON. The idle colour is autoslept (ph#1003 wake), so `starting` is expected right after wake; smoke retries with backoff to a deadline. `build.colour` proves WHICH colour answered. The flip gate requires `ready` by default; `degraded` passes only if each non-ok dependency is on an explicit allow-list supplied to the flip.
- Draining unchanged (`/ready` 503 `draining`, `/live` 200).

## 6. Machine-readable report

One versioned document (`schema: 'saga.readiness/v1'`) from `report()` and `deepReport()`; HTTP status mirrors `verdict`. See `ReadinessReport` in the stubs. Fields: `verdict` (`ready|degraded|not_ready|starting|draining`), `httpStatus`, `build` (colour, version, environment, deployedAt, from existing `buildIdentity()`), `generatedAt`, `summary` counts, and at internal detail per-dependency `{ name, kind, criticality, state, reason, latencyMs, lastSuccessAgeMs, consecutiveFailures, level }`.

Consumers read the same shape: `ss` verify (stage S, local deps), the twin (stages B/D), M4 idle-colour smoke (stage I). Contract: additive changes only inside `v1`; a breaking change is `v2` served alongside for one release. soa-health owns the schema: JSON Schema plus the TypeScript types are exported from a sub-path (`@saga-ed/soa-health/schema`), with no Zod runtime dependency, so consumers validate instead of hand-parsing.

`reason` is a closed enum, not free text (security below). The legacy `checks: Record<string, {ready, detail}>` shape is emitted alongside in `v1` at the `internal` level ONLY, never at `public`, during migration.

## 7. Security

- Responses never contain: connection strings, hostnames/IPs of dependencies, usernames, error messages from the dependency driver, stack traces, SQL, row data, token or key identifiers, parameter or bucket/queue names beyond the declared logical `name`. Driver errors are mapped to the closed `ProbeReason` enum in the runner; raw errors go to the service logger only (with the existing redaction).
- Two detail levels. `public` (default; what an unauthenticated caller, including the ALB and the internet if the route is reachable, receives): `verdict`, `httpStatus`, `build`, `summary` counts. No dependency names or states. `internal`: full per-dependency list. Granted only to a request bearing the internal bearer token, an SSM-sourced secret loaded by the service at boot and compared in constant time (`crypto.timingSafeEqual` over equal-length digests). No token configured means `internal` is unreachable (deny). The token is never logged or echoed. Idle-colour smoke and `ss` fetch it from SSM and send it.
- Today's 1684 `/health/ready` and `/health/deep` expose dependency names and `detail` strings unauthenticated. The new mounter changes that for adopters only (migration step 3); the existing 0.1.x mounters are untouched.
- `/health/deep` stays unauthenticated-reachable at `public` level, so its worst case is the rate-limited probe cost in section 4 and a boolean-ish outcome; internal detail needs authorisation.
- No probe may write, publish, or read PII rows. Schema probes select a primary key only, `findFirst({ select: { id: true } })`, as 1684 does.

## 8. Migration path

1. Ship `createDeepReadiness`/`mountDeepReadiness` additively in soa-health 0.2.0. Every 0.1.x export (`mountReadinessRoutes`, `mountHealthRoutes`, `createDbReadiness`, `awaitDbAtBoot`, `createDrainSignal`, `buildIdentity`) keeps its source and behaviour byte-identical (iam/sis run them in prod); the new code lives in new files and is not reimplemented on top of them or vice versa. A unit test pins the 0.1.x response bodies. Deprecation, if any, is a later major.
2. Pilot: authz-api (client-non-null today; evidence `authz-api/src/main.ts:205`). Manifest: authz-db (postgres, critical, schema probe), openfga (critical), Redis if used (optional). Boot self-test fails closed. Prod TG moves `/health` -> `/health/ready` and container check -> `/health/live`, dev first, then a prod blue/green deploy with idle-colour smoke (per the deploy-wave rules).
3. iam/sis (1684) migrate by replacing `mountIamHealth` with a manifest: iamDb/piiDb (postgres), redis (PING, not `isReady`), kms (aws-kms/custom, `getJwks`). Legacy `checks` is emitted at the internal level only for one release. Public/internal split lands here, with smoke scripts updated to send the bearer token.
4. ledger-api (postgres + rabbitmq), program-hub APIs, student-data-system APIs, saga-dash BFFs by repo. The `http` kind covers BFF -> iam-api/upstream checks.
5. Service template (`ContainerHealthCheckPath`, derived grace period, `READINESS_BOOT` wiring and deploy-workflow input) in rostering/iac as its own PR; lint step in the reusable CI (`assertManifestComplete` via a service unit test, then a repo-level lint that every `apps/node/*` has a manifest) once the majority adopted.
6. Deprecate the ad-hoc paths after all services adopt; remove one major later.

## 9. Trade-offs considered

- Background active probes + cache (chosen) vs probing per request: per-request is the "ALB overloads dependency" failure and makes readiness latency depend on the dependency. Cost of the chosen approach: up to ~15s staleness; mitigated by `observe()` and the deep path for smoke.
- Failing readiness on a shared-dependency outage: harmful (ECS replaces every task, section 5). So shared failures degrade after first success; the cost is that a genuinely broken-for-everyone task keeps serving errors until alerts fire. Gating before first success still catches C3/C5/C6/C11 deltas on a new colour. Confirmed by the owner, 2026-10-25.
- Probing through the real client vs a parallel connection: the real client can be healthy while a fresh connection fails (and vice versa); we want the former because it is what serves traffic. Cost: a probe may queue behind a saturated pool; a pool-acquire timeout is `pool_exhausted`, which is neutral (degrades, never 503), because failing readiness on load sheds capacity when it is needed.  The pooled probe cannot see new-connection failures (token expiry); `freshProbe` (section 4) covers that.

## 10. Decisions from review round 1 and remaining questions

Decided: Q1 gating rule (section 3, confirmed by the owner, 2026-10-25); Q2 structural adapters for pg/prisma/redis/mongo/http/rabbit in the package, `/aws` and `/openfga` as sub-path exports with optional peer deps; Q3 hand-kept discover list for the pilot, registry diff fleet-wide; Q4 soa-health owns the schema, sub-path export, no Zod; Q5 grace period derived (section 5); Q6 SSM bearer, constant-time compare; Q7 flip requires `ready`, allow-list for `degraded`.

Remaining:
1. Bind the LANE field/contract once hipponot/iac#898 lands.

## 11. Implementation notes (0.2.0)

- Adapters are structural (Prisma `$queryRawUnsafe` / pg `query`, MongoClient `db().command`, redis `ping`, amqplib `createChannel`/`checkExchange`, http `probeFetch`), so no `pg`/`@prisma/client`/`redis`/`amqplib` dependency. For the same reason `/aws` and `/openfga` declare NO peer dependencies: a declared optional peer would change the workspace lockfile importers for no typing benefit. `openfga` and `aws-*` kinds require an explicit `probe`; `openfgaProbe` and `awsProbe(op)` are provided.
- The http kind expects the client to expose `probeFetch(url, {method, signal})`, the raw fetch without the app's breaker/retries.
- "Stale cache" = no probe completion or traffic success within `staleAfterMs` (default 60s), independent of whether the dependency itself is up.
- A deep-report `schemaProbe` failure on a critical dependency is `not_ready` in the DEEP report only (deploy smoke needs a hard answer); it never feeds `/health/ready`.
- Unknown `READINESS_BOOT` values resolve to `block`.
- 0.1.x sources are pinned by sha256 in `src/__tests__/compat-0.1.unit.test.ts`.
