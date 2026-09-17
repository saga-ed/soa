# Node Runtime Tier CLAUDE.md Template

> For apps/node/ or packages/node/ directories

# [Tier Name] - Node Runtime

[Brief description of node tier purpose]

## Parent Context

See [/CLAUDE.md](../../CLAUDE.md) for repository-wide context.

## Runtime Environment

**Type**: Backend/Server
**Target**: Node.js 20+ (ESM)
**Build**: tsup → Docker → ECS deployment

## Framework

- Express with routing-controllers
- TypeScript strict mode
- Inversify for dependency injection

## Key Patterns

- See `packages/node/api-core/` for controller patterns
- See `packages/node/db/` for database access
- See `packages/node/logger/` for logging

## Infrastructure Dependencies

| Service | Usage |
|---------|-------|
| MongoDB | [collections and purposes] |
| Redis | [cache keys and patterns] |
| RabbitMQ | [queues consumed/published] |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `PORT` | Server port (default: 3000) |

## Health & Observability

- Health endpoint: `GET /health`
- Metrics: [monitoring solution]
- Logging: structured JSON via @soa/logger

## Projects in This Tier

| Project | Description |
|---------|-------------|
| `[project-name]/` | [Brief description] |

## Convention Deviations

- ⚠️ [Any tier-specific deviations]
