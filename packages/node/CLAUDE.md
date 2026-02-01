# SOA Node Packages

Server-side packages for Node.js applications.

## Parent Context

See [/packages/CLAUDE.md](../CLAUDE.md) for packages overview.

## Runtime Environment

**Type**: Node.js Server
**Target**: Node.js 20+ (ESM)
**Module**: ESM only

## Packages

| Package | Description | Docs |
|---------|-------------|------|
| `api-core/` | Shared API server utilities with abstract controllers for REST/GraphQL/TypeGraphQL/tRPC, server bootstrapping, and dynamic controller loading. | [api-core/](./api-core/CLAUDE.md) |
| `api-util/` | API helper utilities for request validation, response formatting, and error handling. Single-purpose utilities. | Tier |
| `db/` | MongoDB connection management with DI integration, connection pooling, and mock provider for testing. | [db/](./db/CLAUDE.md) |
| `logger/` | Simple Pino logger wrapper with sensible defaults and structured logging. Standard Node.js logging patterns. **Usage:** `import { logger } from '@saga-ed/soa-logger'` | Tier |
| `pubsub-client/` | PubSub client library for subscribing to events. Connects to pubsub-server. Standard event emitter patterns. | Tier |
| `pubsub-core/` | PubSub core types and interfaces. Pure TypeScript types. **Usage:** `import { PubSubEvent } from '@saga-ed/soa-pubsub-core'` | Tier |
| `pubsub-server/` | PubSub server implementation for publishing events. Express middleware integration. Standard pub/sub patterns. | Tier |
| `rabbitmq/` | RabbitMQ client wrapper with connection pooling and channel management. Standard AMQP patterns. **Usage:** `import { RabbitMQ } from '@saga-ed/soa-rabbitmq'` | Tier |
| `redis-core/` | Redis client wrapper with ioredis. Connection pooling and error handling. **Usage:** `import { RedisClient } from '@saga-ed/soa-redis-core'` | Tier |
| `aws-util/` | AWS SDK utilities for S3, SQS, and SNS. Helper functions for common AWS operations. | Tier |
| `test-util/` | Vitest testing utilities with custom matchers and test helpers. **Usage:** `import { createMockRequest } from '@saga-ed/soa-test-util'` | Tier |

**Note:** Packages marked "Tier" are simple/single-purpose and adequately documented here. Complex packages have dedicated CLAUDE.md files.

## Node.js Constraints

Packages in this tier:
- Run in Node.js only
- Can use Node.js APIs (fs, path, process, etc.)
- Cannot run in browser
- May connect to external services (DB, MQ, etc.)

## Key Patterns

### Controller Pattern (api-core)

```typescript
import { BaseController, Get, Post } from '@saga-ed/soa-api-core';

export class UserController extends BaseController {
    @Get('/users')
    async getUsers() { ... }
}
```

### Logging (logger)

```typescript
import { logger } from '@saga-ed/soa-logger';

logger.info('User created', { userId: '123' });
```

### Database (db)

```typescript
import { MongoClient } from '@saga-ed/soa-db';

const client = new MongoClient(config);
```

## Import Pattern

```typescript
// Only import in backend apps (apps/node/*)
import { BaseController } from '@saga-ed/soa-api-core';
import { logger } from '@saga-ed/soa-logger';
import { db } from '@saga-ed/soa-db';
```
