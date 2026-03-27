# trpc-api

tRPC API example with end-to-end type-safe RPC using Zod schemas.

## Responsibilities

- Demonstrates tRPC v11 integration with Express
- Type-safe API with shared router types (`@saga-ed/soa-trpc-types`)
- Sector-based architecture with static router composition
- Project, Run, and PubSub domain management

## Parent Context

See [/apps/node/CLAUDE.md](../CLAUDE.md) for Node.js app patterns.

## Tech Stack

- **Framework**: tRPC v11 + Express
- **Validation**: Zod schemas
- **Server**: Express + routing-controllers (REST) + static tRPC router (RPC)
- **DI**: Inversify (services injected via tRPC context at request time)
- **Database**: MongoDB via @saga-ed/soa-db
- **Build**: tsup → Node.js ESM

## Key Commands

```bash
pnpm dev          # Watch mode with hot reload
pnpm build        # Build types + main (tsup)
pnpm build:types  # Build trpc-types subpackage only
pnpm test         # Run tests
pnpm check-types  # TypeScript type check
```

## Architecture

```
trpc-api/
├── src/
│   ├── main.ts                    # Server bootstrap
│   ├── trpc.ts                    # App-level tRPC init (router, publicProcedure)
│   ├── app-router.ts              # Static router composition, exports AppRouter
│   ├── inversify.config.ts        # DI container setup
│   └── sectors/                   # Domain-driven sectors
│       ├── project/
│       │   ├── trpc/              # Static tRPC router + schemas
│       │   └── rest/              # REST fallback routes
│       ├── run/
│       │   ├── trpc/              # Run router + schemas
│       │   └── rest/              # REST fallback routes
│       └── pubsub/
│           └── trpc/              # PubSub events router
└── trpc-types/                    # Shared AppRouter type package (direct re-export)
```

**Startup Flow:**
1. Load Inversify DI container
2. Auto-discover REST controllers via glob: `./sectors/*/rest/*-routes.js`
3. Import static `appRouter` from `app-router.ts`
4. Mount tRPC middleware + REST controllers on Express
5. Expose health check at `/health`, sectors at `/saga-soa/v1/sectors/list`

**Type Export Flow:**
1. Sector routers defined as plain const exports (no classes/decorators)
2. `app-router.ts` statically imports and composes all sector routers
3. `export type AppRouter = typeof appRouter` — fully static, no codegen
4. `trpc-types/` re-exports `AppRouter` for client consumption

## Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check endpoint |
| `/saga-soa/v1/trpc/*` | tRPC endpoint (project, run, pubsub routers) |
| `/saga-soa/v1/sectors/list` | List available sectors |

## Convention Deviations

- Has a `trpc-types/` sub-package for shared `AppRouter` type (consumed by web-client)
- Dual transport: both tRPC and REST routes in sectors

## See Also

- `../gql-api/` - GraphQL API example (SDL-first)
- `../rest-api/` - REST API example
- `/apps/web/web-client/` - Web client consuming this API
- `/packages/node/api-core/` - Shared server utilities
- `/packages/core/trpc-base/` - Shared tRPC initialization factory

---

*Last updated: 2026-03*
