# Hosted Vishnu API

One Node 24 process serves the static SvelteKit frontend and the read-only tRPC
backend. It uses SOA ExpressServer/Inversify and shared health helpers. JANUS
signature verification and staff permissions guard both assets and API responses.
The synthetic viewer continues to run through its loopback Vite adapter.

## Runtime

Build dependencies, backend and frontend from the repository root:

```sh
pnpm exec turbo run build --filter=@saga-ed/vishnu-api^...
pnpm --filter @saga-ed/vishnu-api build
pnpm --filter @saga-ed/vishnu build
```

Set `VISHNU_ENVIRONMENT=dev`, `VISHNU_DATADOG_ENV=dev`,
`VISHNU_DATADOG_SCOPE=environment`, `VISHNU_MQ_ENABLED=false`, `DD_SITE=datadoghq.com`
and inject `DD_API_KEY`/`DD_APP_KEY` from Secrets Manager. Start with
`pnpm --filter @saga-ed/vishnu-api start`. Default port: 8931.
`VISHNU_STATIC_DIR` overrides the compiled frontend location in the container.
The expected public origin is `https://vishnu.wootops.org`; production uses
`https://vishnu.sagaops.org`. Arbitrary origins and authentication bypasses fail
at startup. Local browser navigation still requires the expected Host and a real
JANUS staff session; the automated test supplies a signed test session locally.

`/trpc/telemetry.mesh`, `.datadog`, and `.eventStats` are GET-only procedures.
`/api/mesh`, `/api/datadog`, and `/api/event-stats` are compatibility routes to
those same procedures. The current frontend uses the compatibility routes.
`/health` and `/health/ready` are unauthenticated ALB checks. Datadog outages do
not cause restart loops: cached observations expire and the UI reports stale or
unavailable data. Readiness checks the MQ connection when that receiver is enabled.

## Observation semantics

Cloud topology combines the three declared applications with services and
relationships observed in APM. APM adjacency is labeled `APM`; it supplies no
protocol, edge count, or edge latency. Service rates/p95 remain service-level
measurements. Lack of data stays unknown. Composite monitor inputs are shown as
evidence, but do not independently raise a critical signal.

Environment scope is explicit because the measured trace series currently lack
`deployment.identifier`. It never falls back silently from deployment scope.
Cloud MQ is disabled for this first deployment: durable storage, receiver scope
and producer adoption need a separate rollout. Synthetic MQ remains supported.

## Validation and deployment

```sh
pnpm --filter @saga-ed/vishnu-api test
pnpm --filter @saga-ed/vishnu-api check-types
pnpm --filter @saga-ed/vishnu-api test:browser
```

The browser test requires the frontend/backend builds and Playwright Chromium.
It checks a signed staff session, cloud scope, graph layout, inspector statistics
and disabled MQ state. See [deployment operations](../../../infra/vishnu-api/OPS.md).
