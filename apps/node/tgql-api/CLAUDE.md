# tgql-api

TypeGraphQL API example using Apollo Server with code-first schema.

## Responsibilities

- Demonstrates TypeGraphQL (code-first GraphQL) with Apollo Server
- Decorator-based resolvers and type definitions
- Sector-based architecture with resolver auto-loading
- Schema generation and emission via TypeGraphQL
- User and session management via GraphQL queries/mutations

## Parent Context

See [/apps/node/CLAUDE.md](../CLAUDE.md) for Node.js app patterns.

## Tech Stack

- **Framework**: Apollo Server 4 + TypeGraphQL
- **Schema**: Code-first (TypeScript decorators)
- **Server**: Express + routing-controllers
- **DI**: Inversify
- **Database**: MongoDB via @saga-ed/soa-db
- **Build**: tsup → Node.js ESM
- **Codegen**: GraphQL schema emission via TypeGraphQL

## Key Commands

```bash
pnpm dev              # Watch mode with hot reload
pnpm build            # Build for production
pnpm start            # Run production build
pnpm test             # Run tests
pnpm emit:schema      # Generate GraphQL schema file
```

## Architecture

```
src/
├── main.ts                    # Server bootstrap
├── inversify.config.ts        # DI container setup
└── sectors/                   # Domain-driven sectors
    ├── user/
    │   └── gql/
    │       └── user.resolver.js   # User TypeGraphQL resolver
    └── session/
        └── gql/
            └── session.resolver.js # Session resolver
```

**Startup Flow:**
1. Load Inversify DI container
2. Auto-discover resolvers via glob: `./sectors/*/gql/*.resolver.js`
3. Build TypeGraphQL schema from resolver classes
4. Initialize Apollo Server with generated schema
5. Mount GraphQL endpoint at `/saga-soa/v1`
6. Expose health check at `/health`

## Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check endpoint |
| `/saga-soa/v1` | GraphQL endpoint (queries/mutations) |
| `/saga-soa/v1/sectors/list` | List available sectors |

## Convention Deviations

None - follows all SOA patterns.

## See Also

- `../gql-api/` - Apollo GraphQL API (SDL-first approach)
- `../rest-api/` - REST API example
- `/packages/node/api-core/` - Shared server utilities
- `/apps/node/claude/testing.md` - Testing patterns
