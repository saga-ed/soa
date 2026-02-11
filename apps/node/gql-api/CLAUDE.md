# gql-api

GraphQL API example using Apollo Server with SDL-first schema.

## Responsibilities

- Demonstrates Apollo Server integration with Express
- Schema-first GraphQL API (SDL-based, not TypeGraphQL)
- Sector-based architecture with resolver auto-loading
- User and session management via GraphQL queries/mutations

## Parent Context

See [/apps/node/CLAUDE.md](../CLAUDE.md) for Node.js app patterns.

## Tech Stack

- **Framework**: Apollo Server 4
- **Schema**: GraphQL SDL (Schema Definition Language)
- **Server**: Express + routing-controllers
- **DI**: Inversify
- **Database**: MongoDB via @saga-ed/soa-db
- **Build**: tsup → Node.js ESM

## Key Commands

```bash
pnpm dev          # Watch mode with hot reload
pnpm build        # Build for production
pnpm start        # Run production build
pnpm test         # Run tests
```

## Architecture

```
src/
├── main.ts                    # Server bootstrap
├── inversify.config.ts        # DI container setup
└── sectors/                   # Domain-driven sectors
    ├── user/
    │   └── gql/
    │       └── user.resolver.js   # User GraphQL resolver
    └── session/
        └── gql/
            └── session.resolver.js # Session resolver
```

**Startup Flow:**
1. Load Inversify DI container
2. Auto-discover resolvers via glob: `./sectors/*/gql/*.resolver.js`
3. Initialize Apollo Server with SDL schema
4. Mount GraphQL endpoint at `/saga-soa/v1`
5. Expose health check at `/health`

## Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check endpoint |
| `/saga-soa/v1` | GraphQL endpoint (queries/mutations) |
| `/saga-soa/v1/sectors/list` | List available sectors |

## Convention Deviations

None - follows all SOA patterns.

## See Also

- `../rest-api/` - REST API example
- `../tgql-api/` - TypeGraphQL API example (code-first)
- `/packages/node/api-core/` - Shared server utilities
- `/apps/node/claude/testing.md` - Testing patterns

---

*Last updated: 2026-02*
