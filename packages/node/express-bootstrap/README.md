# @saga-ed/soa-express-bootstrap

The Express bootstrap floor every SOA-backed service was hand-rolling: the
shared security/parsing middleware stack, the canonical Saga CORS allowlist, and
a graceful-shutdown harness.

It owns the *bootstrap*, not the *domain* — auth perimeter, tRPC/GraphQL/REST
wiring, DI, and health-check bodies stay in each app.

## Install

```jsonc
// package.json
"dependencies": { "@saga-ed/soa-express-bootstrap": "workspace:*" }
```

## Usage

```ts
import express from 'express';
import {
  applyBaseMiddleware,
  installGracefulShutdown,
} from '@saga-ed/soa-express-bootstrap';

const app = express();

// helmet → rate-limit (skips /health) → cors → json → cookies → request-log
applyBaseMiddleware(app, {
  logger,
  cors: { devOrigins: ['http://localhost:5173'] },
  rateLimit: { windowMs: securityConfig.rateLimitWindowMs, maxRequests: securityConfig.rateLimitMaxRequests },
  jsonBodyLimit: securityConfig.jsonBodyLimit,
});

// ... app-specific perimeter (janusContext/requireAuth), tRPC, REST, health ...

const server = app.listen(port);

installGracefulShutdown({
  logger,
  server,
  closers: [
    { name: 'outbox relay', close: () => outboxRelay.stop() },
    { name: 'postgres', close: () => pgProvider.disconnect() },
    { name: 'otel tracing', close: () => tracingHandle.shutdown() },
  ],
});
```

## API

- `applyBaseMiddleware(app, opts)` — mounts the shared stack in canonical order.
  Each layer is individually skippable (`cors: false`, `rateLimit: false`,
  `helmet: false`, `cookies: false`, `requestLogger: false`).
- `buildSagaCorsOptions(opts)` — `cors` options around the env-isolated
  `buildSagaOriginAllowlist` from `@saga-ed/soa-api-util` (prod trusts
  `*.saga.org`, dev `*.wootdev.com`); exposes `WWW-Authenticate` for the
  SagaAuth login interceptor.
- `requestIdLogger(logger)` — request-id propagation + structured access log.
- `installGracefulShutdown(opts)` / `createGracefulShutdown(opts)` — ordered
  best-effort teardown behind a force-exit deadline. `create*` returns the
  routine without registering signal handlers (for tests).

## What this replaces

Extracted from the near-identical `main.ts` bootstrap in student-data-system
(chat/insights/transcripts/ledger APIs), program-hub (4 APIs), coach, and
rostering. See `claude/cross-repo-consolidation-plan.md` Tier A.
