# @saga-ed/pubsub-server

Server implementation for the saga-soa pub/sub infrastructure, providing tRPC procedures, SSE handlers, and core services.

## Overview

This package implements the server-side functionality for the pub/sub system, including:

- **tRPC Procedures**: `sendEvent`, `subscribe`, `fetchHistory`, and `health`
- **SSE Handler**: Server-Sent Events endpoint for real-time updates
- **Core Services**: Event validation, action execution, and channel management
- **Dependency Injection**: Inversify-based service management

## Features

- **Event Validation**: Zod schema validation for event payloads
- **Action Execution**: Server-side action execution with event emission
- **Authorization**: Role-based access control for events and channels
- **Channel Management**: Configurable channels with policies and limits
- **Real-time Subscriptions**: tRPC subscriptions and SSE support
- **Health Monitoring**: Comprehensive health checks and metrics

## Installation

This package is part of the saga-soa workspace and should be used as a workspace dependency:

```json
{
  "dependencies": {
    "@saga-ed/pubsub-server": "workspace:*"
  }
}
```

## Usage

### Basic Setup

```typescript
import { createPubSubServer } from '@saga-ed/pubsub-server';
import { MockAdapter } from '@saga-ed/pubsub-core';
import { initTRPC } from '@trpc/server';

// Define your events
const events = {
  'orders:created': {
    name: 'orders:created',
    channel: 'orders',
    direction: 'BOTH',
    action: async (ctx, payload) => {
      // Server-side action
      return { success: true };
    }
  }
};

// Create base tRPC router
const t = initTRPC.context<ServerCtx>().create();
const baseRouter = t.router({ /* your procedures */ });

// Create pub/sub server
const pubsub = createPubSubServer({
  router: baseRouter,
  events,
  adapter: new MockAdapter(),
  channels: [
    {
      name: 'orders',
      family: 'commerce',
      ordered: true,
      maxSubscribers: 1000
    }
  ]
});

// Use the enhanced router
export const appRouter = pubsub.getRouter();
```

### tRPC Procedures

The package automatically adds these procedures to your router:

#### `sendEvent` (Mutation)
```typescript
// Send an event
const result = await trpc.sendEvent.mutate({
  name: 'orders:created',
  payload: { orderId: '123', total: 100 },
  clientEventId: 'client-123'
});

// Result: { status: 'success', result: {...}, emittedEvents: [...] }
```

#### `subscribe` (Subscription)
```typescript
// Subscribe to a channel
const subscription = trpc.subscribe.subscribe({
  channel: 'orders',
  filters: { name: 'orders:created' }
});

subscription.subscribe({
  next: (event) => console.log('Received event:', event),
  error: (error) => console.error('Subscription error:', error)
});
```

#### `fetchHistory` (Query)
```typescript
// Fetch event history
const history = await trpc.fetchHistory.query({
  channel: 'orders',
  since: '2024-01-01T00:00:00Z',
  limit: 100
});
```

#### `health` (Query)
```typescript
// Check system health
const health = await trpc.health.query();
// Returns: { healthy: boolean, details: {...} }
```

### SSE Handler

```typescript
import express from 'express';

const app = express();

// SSE endpoint
app.get('/events', async (req, res) => {
  await pubsub.createSSEHandler(req, res);
});
```

## Architecture

### Services

- **EventService**: Event validation, action execution, and authorization
- **ChannelService**: Channel configuration and access control
- **PubSubService**: Main orchestration service

### Dependency Injection

The package uses Inversify for dependency injection:

```typescript
import { container } from '@saga-ed/pubsub-server';

// Bind external dependencies
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).toConstantValue(adapter);
container.bind<Logger>(TYPES.Logger).toConstantValue(logger);

// Get services
const pubSubService = container.get<PubSubService>(TYPES.PubSubService);
```

### Event Flow

1. **Client sends event** via `sendEvent` mutation
2. **Event validation** against schema and authorization
3. **Action execution** if defined (with optional event emission)
4. **Event publishing** to all subscribers
5. **Real-time delivery** via tRPC subscriptions and SSE

## Configuration

### Channel Configuration

```typescript
const channels = [
  {
    name: 'orders',
    family: 'commerce',
    authScope: 'user',
    ordered: true,
    maxSubscribers: 1000,
    maxEventSize: 1024 * 1024, // 1MB
    historyRetentionMs: 24 * 60 * 60 * 1000 // 24 hours
  }
];
```

### Event Definition

```typescript
const eventDefinition = {
  name: 'orders:created',
  channel: 'orders',
  payloadSchema: z.object({
    orderId: z.string(),
    total: z.number()
  }),
  direction: 'BOTH', // SSE, CSE, or BOTH
  action: async (ctx, payload) => {
    // Server-side action
    return { success: true };
  },
  authScope: 'user',
  version: 1
};
```

## Testing

Run the test suite:

```bash
pnpm test
```

Run with coverage:

```bash
pnpm test --coverage
```

### Test Structure

- **Unit Tests**: Individual service testing
- **Integration Tests**: End-to-end flow testing
- **Mocks**: Mock logger and adapter implementations

## Dependencies

- **@saga-ed/pubsub-core**: Core types and interfaces
- **@saga-ed/api-core**: Base API functionality
- **@saga-ed/logger**: Logging service
- **@trpc/server**: tRPC server implementation
- **inversify**: Dependency injection
- **zod**: Schema validation

## Contributing

1. Follow the monorepo patterns established in saga-soa
2. Use ESM imports and exports
3. Write comprehensive tests for new features
4. Update this README when adding new functionality

## License

Private - part of the saga-soa monorepo 