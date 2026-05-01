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
| `fixture-serve/` | Ready-to-run Express server for test fixture lifecycle — provision/snapshot/restore endpoints, async jobs, Playwright credential export, infra-compose integration. Subclass `AbstractFixtureController` per service. | [fixture-serve/](./fixture-serve/CLAUDE.md) |
| `logger/` | Simple Pino logger wrapper with sensible defaults and structured logging. Standard Node.js logging patterns. **Usage:** `import { logger } from '@saga-ed/soa-logger'` | Tier |
| `pubsub-client/` | PubSub client library for subscribing to events. Connects to pubsub-server. Standard event emitter patterns. | Tier |
| `pubsub-core/` | PubSub core types and interfaces. Pure TypeScript types. **Usage:** `import { PubSubEvent } from '@saga-ed/soa-pubsub-core'` | Tier |
| `pubsub-server/` | PubSub server implementation for publishing events. Express middleware integration. Standard pub/sub patterns. | Tier |
| `rabbitmq/` | RabbitMQ client wrapper with connection pooling and channel management. Standard AMQP patterns. **Usage:** `import { RabbitMQ } from '@saga-ed/soa-rabbitmq'` | Tier |
| `redis-core/` | Redis client wrapper with ioredis. Connection pooling and error handling. **Usage:** `import { RedisClient } from '@saga-ed/soa-redis-core'` | Tier |
| `aws-util/` | AWS SDK utilities for S3, SQS, and SNS. Helper functions for common AWS operations. | Tier |
| `test-util/` | Vitest testing utilities with custom matchers and test helpers. **Usage:** `import { createMockRequest } from '@saga-ed/soa-test-util'` | Tier |
| `event-envelope/` | Zod-validated cross-service event envelope (id, type, version, occurredAt, traceparent, payload). **Usage:** `import { EventEnvelopeSchema } from '@saga-ed/soa-event-envelope'` | [event-driven.md](./claude/event-driven.md) |
| `event-outbox/` | Transactional outbox: `writeOutbox()` writes inside the same pg tx as your domain change; `new OutboxRelay({...}).start()` ships rows to RabbitMQ with at-least-once delivery. | [event-driven.md](./claude/event-driven.md) |
| `event-consumer/` | Idempotent RabbitMQ consumer with `consumed_events` dedup table, Zod runtime validation, OTel trace propagation. | [event-driven.md](./claude/event-driven.md) |
| `observability/` | OpenTelemetry tracing setup, Prometheus metrics for outbox/consumer, Express error middleware. **Usage:** `import { initTracing } from '@saga-ed/soa-observability'` | [event-driven.md](./claude/event-driven.md) |
| `event-test-harness/` | Testcontainers helpers for spinning up Postgres + RabbitMQ in integration tests. **Usage:** `import { startInfra } from '@saga-ed/soa-event-test-harness'` | [event-driven.md](./claude/event-driven.md) |
| `event-integration-tests/` | Cross-package integration tests for the event-driven stack (outbox → broker → consumer round-trips). | [event-driven.md](./claude/event-driven.md) |

**Note:** Packages marked "Tier" are simple/single-purpose and adequately documented here. Complex packages have dedicated CLAUDE.md files. The event-driven family share [claude/event-driven.md](./claude/event-driven.md).

## Two pubsub families — pick one

- **`pubsub-*`** (`pubsub-core`, `pubsub-client`, `pubsub-server`) — real-time UI push (browser ↔ server). Lives on top of HTTP/SSE. Use for live dashboards, notifications, collaborative cursors.
- **`event-*`** + `observability` — durable cross-service eventing (server ↔ server) over RabbitMQ with transactional outbox + idempotency. Use for domain events that must survive broker restarts and be replayed safely.

These are NOT interchangeable. See `~/dev/soa/.claude/projects/soa_75/decisions/d-soa-pubsub-divorce.md` for the rationale.

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

---

*Last updated: 2026-02*
