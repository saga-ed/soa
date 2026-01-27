# SOA Node Applications

Backend applications running in Node.js environment.

## Parent Context

See [/apps/CLAUDE.md](../CLAUDE.md) for apps overview.

## Runtime Environment

**Type**: Backend/Server
**Target**: Node.js 20+ (ESM)
**Build**: tsup → Docker → ECS deployment

## Projects

| Project | API Style | Description |
|---------|-----------|-------------|
| `trpc-api/` | tRPC | Type-safe RPC API example |
| `rest-api/` | REST | Express REST API example |
| `gql-api/` | GraphQL | Apollo GraphQL API example |
| `tgql-api/` | TypeGraphQL | TypeGraphQL API example |

## Framework Stack

- Express with routing-controllers
- TypeScript strict mode
- Inversify for dependency injection
- Vitest for testing

## Key Packages

```typescript
import { BaseController, Get } from '@saga-ed/soa-api-core';
import { logger } from '@saga-ed/soa-logger';
import { db } from '@saga-ed/soa-db';
```

## Development

```bash
# Run trpc-api
pnpm --filter trpc-api dev

# Run rest-api
pnpm --filter rest-api dev
```

## Health Endpoints

All APIs expose:
- `GET /health` - Health check endpoint

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | Environment (development/production) |

## Testing

See [claude/testing.md](./claude/testing.md) for:
- Controller loading patterns
- DI/Inversify testing
- Database isolation for parallel tests

See [claude/esm.md](../../claude/esm.md) for ESM patterns (__dirname workaround, imports).
