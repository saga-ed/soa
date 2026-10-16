# @saga-ed/soa-health

Framework-free health/readiness route mounters for Saga Node services. Mount before any auth perimeter.

## Recommended wiring

| Consumer | Path | Backed by |
|---|---|---|
| ALB target group | `/health/ready` | `createDbReadiness().probe` (reads state, never queries the DB) |
| ECS container healthCheck | `/health/live` | always 200, including while draining |
| Deploy smoke / humans | `/health/deep` | `deepProbes` that really hit dependencies; never an ALB path |

```ts
const drain = createDrainSignal();
const dbReadiness = createDbReadiness({ ping: () => prisma.$queryRawUnsafe('SELECT 1') });

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
