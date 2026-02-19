# api-core

Shared API server utilities for building Node.js backend services.

## Responsibilities

- Abstract base controllers for REST, GraphQL, TypeGraphQL, and tRPC
- Express server bootstrapping and configuration
- Apollo Server (GraphQL) and TypeGraphQL integration
- Dynamic controller/resolver loading via glob patterns
- Server configuration schemas (Zod-validated)
- Sector pattern support (automatic route/resolver discovery)

## Parent Context

See [/packages/node/CLAUDE.md](../CLAUDE.md) for Node.js package patterns.

## Tech Stack

- **Server**: Express + routing-controllers
- **GraphQL**: Apollo Server 4 + TypeGraphQL
- **RPC**: tRPC
- **DI**: Inversify
- **Validation**: Zod
- **Build**: tsup → ESM

## Structure

```
src/
├── abstract-rest-controller.ts       # Base REST controller
├── abstract-gql-controller.ts        # Base GraphQL resolver (SDL)
├── abstract-tgql-controller.ts       # Base TypeGraphQL resolver
├── abstract-trpc-controller.ts       # Base tRPC router
├── express-server.ts                 # Express server class
├── gql-server.ts                     # Apollo GraphQL server
├── tgql-server.ts                    # TypeGraphQL server
├── trpc-server.ts                    # tRPC server
├── sectors-controller.ts             # Sector listing endpoint
└── utils/
    ├── loadControllers.ts            # Controller auto-discovery
    └── schema-loader.ts              # GraphQL schema loader
```

## Key Exports

```typescript
// Base controllers
import { AbstractRestController } from '@saga-ed/soa-api-core';
import { AbstractGQLController } from '@saga-ed/soa-api-core';
import { AbstractTGQLController } from '@saga-ed/soa-api-core';
import { AbstractTRPCController } from '@saga-ed/soa-api-core';

// Server classes
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import { GQLServer } from '@saga-ed/soa-api-core/gql-server';
import { TGQLServer } from '@saga-ed/soa-api-core/tgql-server';

// Utilities
import { ControllerLoader } from '@saga-ed/soa-api-core/utils/controller-loader';
```

## Key Features

**Controller Auto-Loading:**
- Scans directories for controllers/resolvers using glob patterns
- Validates controller inheritance (must extend abstract base classes)
- Integrates with Inversify DI container

**Multi-API Support:**
- REST via routing-controllers decorators
- GraphQL via Apollo Server (SDL-first)
- TypeGraphQL via decorators (code-first)
- tRPC via router definitions

**Server Bootstrapping:**
- ExpressServer: REST endpoints with routing-controllers
- GQLServer: Apollo GraphQL with SDL schemas
- TGQLServer: TypeGraphQL with decorator-based schemas
- All servers support Inversify DI and health checks

## Convention Deviations

None - exemplary package following all SOA patterns.

## See Also

- `/apps/node/gql-api/` - GraphQL API example
- `/apps/node/rest-api/` - REST API example
- `/apps/node/tgql-api/` - TypeGraphQL API example
- `/packages/node/CLAUDE.md` - Node.js package patterns

---

*Last updated: 2026-02*
