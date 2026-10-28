# @saga-ed/soa-health

Framework-free health/readiness route mounters for Saga Node services. Mount before any auth perimeter.

## Recommended wiring

| Consumer | Path | Backed by |
|---|---|---|
| ALB target group | `/health/ready` | `createDbReadiness().probe` (reads state, never queries the DB) |
| ECS container healthCheck | `/health/live` | always 200, including while draining |
| Deploy smoke / humans | `/health/deep` | `deepProbes` that really hit dependencies (result cached `deepCacheMs`, default 5s, concurrent calls coalesced); never an ALB path |

```ts
const drain = createDrainSignal();
const ping = () => prisma.$queryRawUnsafe('SELECT 1');
const dbReadiness = createDbReadiness({ ping });

mountReadinessRoutes(app, {
  probes: { db: dbReadiness.probe },
  deepProbes: { db: async () => (await ping(), { ready: true, detail: 'connected' }) },
  isDraining: drain.isDraining,
});

await awaitDbAtBoot(ping, { onRetry: (n, err) => log.warn({ n, err }, 'db not ready') }); // throws -> process crashes before listen()
dbReadiness.start();
app.listen(port);

process.on('SIGTERM', () => drain.startDraining()); // then stop accepting work after the ALB deregisters
```

- `createDbReadiness`: 503 (`starting`) until the first success, `stale` when no success for `staleAfterMs` (default 5 min, catches expired RDS IAM tokens). Call `markSuccess()` from a Prisma extension / pool hook so busy services skip background pings.
- `awaitDbAtBoot`: retries until the deadline, then throws so the ECS circuit breaker rolls the deploy back.
- `isDraining`: `/health` and `/health/ready` return 503 `draining` without running probes.
- `/health/details` returns 503 when unhealthy.

## Deep readiness (0.2.0, soa#517)

Declare dependencies once; the same probe set drives boot self-test, `/health/ready` (cache only) and `/health/deep`. Design and semantics: [docs/deep-readiness.md](docs/deep-readiness.md). Adopting in a service: [docs/adoption-runbook.md](docs/adoption-runbook.md).

```ts
const dr = createDeepReadiness({
  manifest: declareDependencies({
    service: 'authz-api',
    dependencies: [
      dep({ name: 'authzDb', kind: 'prisma', criticality: 'critical', scope: 'shared', client: () => prisma }),
      dep({ name: 'redis', kind: 'redis', criticality: 'optional', client: () => redis }),
    ],
  }),
  isDraining: drain.isDraining,
  authorizeInternal: createBearerAuthorizer(() => ssmBearerToken), // internal detail level; default deny
});
mountDeepReadiness(app, dr);
await dr.boot(); // READINESS_BOOT=block|warn|open
dr.start();
```

### 0.4.0 (soa#504) — fresh-connection probe

- `DependencyDeclaration` gains `freshProbe(signal)` and `freshIntervalMs` (default 300000): a slower, independent probe that opens a NEW connection, so credential/token expiry that pooled probes miss (SQLSTATE 28000 / PAM) fails readiness like any active-probe failure. A pooled or `observe()` success never clears it; boot needs a fresh success too. `pgFreshProbe(() => new Client(...))` builds one for `pg` (structural `PgClientLike`, no `pg` dependency). Semantics: [docs/deep-readiness.md](docs/deep-readiness.md) section 4.

### 0.3.0 (soa#515) — breaking: deep seam

- Breaking: `CreateDeepReadinessOptions.env` is removed. Pass `identity` (soa-env's resolved `EnvIdentity`); an absent client defaults to `skipped` only when `identity.account.kind` is `local` (`SAGA_LOCAL=1`), otherwise it fails closed. `DeepReadiness.identity` exposes it.
- New `identity` option on `mountHealthRoutes` and `mountReadinessRoutes`; `buildIdentity(env, identity)` adds `profile`, `lane`, `telemetryEnv`, `accountKind` to the build identity (never `account.id` or `row`). `environment` (raw `EXEC_ENV`) stays as a deprecated alias of `profile`.

`@saga-ed/soa-health/schema` exports the `saga.readiness/v1` JSON Schema; `/aws` (`awsProbe`) and `/openfga` (`openfgaProbe`) export the probes for those kinds. The 0.1.x exports are unchanged.
