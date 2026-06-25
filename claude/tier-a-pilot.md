# Tier A pilot — backend bootstrap hoist

*Status: in progress · 2026-06-25 · see [cross-repo-consolidation-plan.md](./cross-repo-consolidation-plan.md) Tier A*

First slice of the Tier A "backend service bootstrap" hoist. Two of the seven
Tier A items are built, tested, and type-checked. The larger items (DI factory,
Postgres `initDb`, tRPC factory) remain as documented next steps.

## What landed in SOA

### A5 — env-coercion helpers → `@saga-ed/soa-config`
New module `src/zod-env.ts`, exported from the index and a `./zod-env` subpath.
- `envBoolean` — string `'true'` → boolean (the byte-identical copy in every backend repo).
- `emptyStringToUndefined(inner)` — empty-string env var → `undefined` (the CFN-default dance from rostering). **Inner schema must be `.optional()`/`.default()`** — verification caught this; doc + tests corrected.
- `envNumber`, `envStringArray` — number coercion + comma-separated list.
- Lives in `soa-config` (zod **3.25.67**) because every consumer pins zod 3; `soa-api-util` is on zod 4 and would type-clash.

### A2 — `@saga-ed/soa-express-bootstrap` (new package, `packages/node/express-bootstrap`)
- `applyBaseMiddleware(app, opts)` — `helmet → rate-limit (skips /health) → cors → json → cookies → request-log`, each layer skippable.
- `buildSagaCorsOptions(opts)` — wraps the **existing** env-isolated `buildSagaOriginAllowlist` from `soa-api-util` (so this also retires the hand-rolled `VALID_DOMAINS` allowlist — plan item C2) and exposes `WWW-Authenticate` for the SagaAuth interceptor.
- `installGracefulShutdown` / `createGracefulShutdown` — ordered best-effort teardown behind a force-exit deadline. **Genuinely new** — no shutdown harness existed in SOA.
- `requestIdLogger(logger)` — request-id propagation + structured access log.

### Verification
24/24 unit/int tests pass against real `zod@3.25.67`, `express@4`, `cors`,
`helmet@8`, `express-rate-limit@8`; `tsc --noEmit` clean under SOA's exact base
compiler options (`strict`, `NodeNext`, `noUncheckedIndexedAccess`). Run in an
isolated harness because the monorepo install is CodeArtifact-gated in this env.

## Consumer demonstration — student-data-system `chat-api`

The pattern below is **identical** across SDS chat/insights/transcripts/ledger,
program-hub's 4 APIs, coach, and rostering's iam-api/sis-api. `chat-api/src/main.ts`
is 389 lines; ~95 of them are the boilerplate these two packages own.

### Before (`apps/node/chat-api/src/main.ts`, abridged)

```ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { VALID_DOMAINS } from './config/valid-domains.js';
import { requestLogger } from './middleware/request-logger.js';
// ...
const app = express();
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } }));
app.use(rateLimit({ windowMs: securityConfig.rateLimitWindowMs, max: securityConfig.rateLimitMaxRequests,
  skip: (req) => req.path.startsWith('/health'), standardHeaders: true, legacyHeaders: false }));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    let host: string;
    try { host = new URL(origin).hostname; } catch { return cb(new Error(`CORS: invalid origin ${origin}`)); }
    if (LOCAL_HOSTS.has(host)) return cb(null, true);
    const allowed = VALID_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    return allowed ? cb(null, true) : cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  allowedHeaders: ['content-type', 'x-playwright-waf-bypass'],
  exposedHeaders: ['x-request-id', 'WWW-Authenticate'],
}));
app.use(express.json({ limit: securityConfig.jsonBodyLimit }));
app.use(cookieParser());
app.use(requestLogger(logger));
// ... ~45 more lines of hand-rolled SIGTERM/SIGINT shutdown with a 5s force-exit timer ...
```

### After

```ts
import express from 'express';
import { applyBaseMiddleware, installGracefulShutdown } from '@saga-ed/soa-express-bootstrap';
// ...
const app = express();
applyBaseMiddleware(app, {
  logger,
  cors: { devOrigins: ['http://localhost:8900'], allowedHeaders: ['x-playwright-waf-bypass'] },
  rateLimit: { windowMs: securityConfig.rateLimitWindowMs, maxRequests: securityConfig.rateLimitMaxRequests },
  jsonBodyLimit: securityConfig.jsonBodyLimit,
});

// ... app-specific perimeter (janusContext/requireAuth), tRPC, REST, health stay as-is ...

const server = app.listen(port, () => logger.info('--- Chat API started ---'));

installGracefulShutdown({
  logger,
  server,
  closers: [
    { name: 'outbox relay', close: () => outboxRelay?.stop() },
    { name: 'postgres', close: () => pgProvider?.disconnect() },
    { name: 'otel tracing', close: () => tracingHandle.shutdown() },
  ],
});
```

**Net:** ~95 lines → ~18 per service, and the local `config/valid-domains.ts`
+ `middleware/request-logger.ts` files are deleted (the canonical allowlist now
comes from `soa-api-util`). Behaviour change worth noting: blanket localhost is
replaced by explicit `devOrigins` — a deliberate security tightening already
standard in saga-dash / `soa-api-util`.

## Adoption steps (per consumer, once published)

1. Publish `@saga-ed/soa-config` (minor bump for the new export) and
   `@saga-ed/soa-express-bootstrap@0.1.0` to CodeArtifact.
2. In the consumer: add the dep (`workspace:*` in-repo; pinned version cross-repo),
   swap the imports, delete the local `valid-domains.ts` / `request-logger.ts`,
   replace the shutdown block.
3. `pnpm build && pnpm test` per service. Roll one service first (chat-api),
   then fan out to its siblings.

> Cross-repo version bumps are coordinated — every consumer CLAUDE.md says "match
> SOA versions exactly." Budget a bump PR per repo.

## Remaining Tier A (not yet built)

- **A1** `soa-di-bootstrap` — Inversify container factory (largest LOC win, ~2,400 across cluster).
- **A3** `soa-postgres` `initDb` — RDS IAM + reconnect (the SDS `*-db` ×5 / rostering `db-init` duplication).
- **A4** `soa-trpc-base` extension — `protectedProcedure` + `enforceAuth`.
- **A6** `soa-auth-context` — AsyncLocalStorage auth context (already an identical copy ×3 in SDS).
- **A7** tracing-init template + health-probe standardisation on `soa-health`.
