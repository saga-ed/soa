# SOA Node Packages

Server-side packages for Node.js applications.

## Parent Context

See [/packages/CLAUDE.md](../CLAUDE.md) for packages overview.

## Runtime Environment

**Type**: Node.js Server
**Target**: Node.js 20+ (ESM)
**Module**: ESM only

## Packages

| Package | Description |
|---------|-------------|
| `api-core/` | Express controllers, server utilities |
| `api-util/` | API helper utilities |
| `db/` | MongoDB, MySQL, Redis connections |
| `logger/` | Pino-based structured logging |
| `pubsub-client/` | PubSub client library |
| `pubsub-core/` | PubSub core types/interfaces |
| `pubsub-server/` | PubSub server implementation |
| `rabbitmq/` | RabbitMQ client wrapper |
| `redis-core/` | Redis client wrapper |
| `aws-util/` | AWS SDK utilities |
| `test-util/` | Vitest testing utilities |

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
