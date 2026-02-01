# rest-api

REST API example using Express with routing-controllers.

## Responsibilities

- Demonstrates REST API patterns with Express
- Decorator-based routing via routing-controllers
- Sector-based architecture with controller auto-loading
- Express middleware and request/response handling

## Parent Context

See [/apps/node/CLAUDE.md](../CLAUDE.md) for Node.js app patterns.

## Tech Stack

- **Framework**: Express + routing-controllers
- **Style**: REST (JSON over HTTP)
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
└── sectors/                   # Domain controllers
    └── *.js                   # Sector REST controllers
```

**Startup Flow:**
1. Load Inversify DI container
2. Auto-discover REST controllers via glob: `./sectors/*.js`
3. Initialize Express server with routing-controllers
4. Mount controllers at base path `/saga-soa/v1`
5. Expose health check at `/health`

## Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check endpoint |
| `/saga-soa/v1/*` | REST endpoints (sector routes) |
| `/saga-soa/v1/sectors/list` | List available sectors |

## Convention Deviations

None - follows all SOA patterns.

## See Also

- `../gql-api/` - GraphQL API example (SDL-first)
- `../tgql-api/` - TypeGraphQL API example (code-first)
- `/packages/node/api-core/` - Shared server utilities
- `/apps/node/claude/testing.md` - Testing patterns
