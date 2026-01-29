# @saga-ed/pubsub-client

A TypeScript client library for pubsub functionality using tRPC, providing type-safe event publishing and subscription capabilities.

## Features

- **CSE (Client-Sent Events)**: Publish events via tRPC mutations
- **SSE (Server-Sent Events)**: Subscribe to real-time event streams
- **Type Safety**: Full TypeScript support with proper type inference
- **Event Validation**: Built-in payload validation using Zod schemas
- **Subscription Management**: Automatic cleanup and resource management
- **Error Handling**: Comprehensive error handling and retry logic

## Installation

```bash
pnpm add @saga-ed/pubsub-client
```

## Quick Start

```typescript
import { TRPCPubSubClient } from '@saga-ed/pubsub-client';

// Create client instance
const client = new TRPCPubSubClient({
  baseUrl: 'http://localhost:5000',
  tRPCPath: '/saga-soa/v1/trpc'
});

// Publish a CSE event
const result = await client.publish('ping:message', {
  message: 'Hello, World!',
  timestamp: new Date().toISOString()
});

// Subscribe to SSE events
const subscription = await client.subscribe('pingpong', (event) => {
  console.log('Received event:', event);
});

// Clean up
await subscription.unsubscribe();
await client.close();
```

## API Reference

### TRPCPubSubClient

The main client class for pubsub operations.

#### Constructor

```typescript
new TRPCPubSubClient(config: TRPCPubSubClientConfig)
```

**Config Options:**
- `baseUrl`: Base URL of the tRPC server
- `tRPCPath`: Path to the tRPC endpoint (default: `/trpc`)
- `headers`: Additional HTTP headers
- `timeout`: Request timeout in milliseconds

#### Methods

##### `publish(eventName, payload, options?)`

Publishes a CSE event via tRPC.

```typescript
const result = await client.publish('user:created', {
  userId: '123',
  email: 'user@example.com'
});
```

##### `subscribe(channel, handler)`

Subscribes to a channel for SSE events.

```typescript
const subscription = await client.subscribe('users', (event) => {
  console.log('User event:', event);
});
```

##### `unsubscribe(subscriptionId)`

Unsubscribes from a specific subscription.

```typescript
await client.unsubscribe(subscriptionId);
```

##### `unsubscribeAll()`

Unsubscribes from all active subscriptions.

```typescript
await client.unsubscribeAll();
```

##### `close()`

Closes the client and cleans up all resources.

```typescript
await client.close();
```

## Event Types

### EventName

Event names follow the pattern `${string}:${string}` (e.g., `user:created`, `order:updated`).

### EventEnvelope

```typescript
interface EventEnvelope<Name extends EventName, Payload = unknown> {
  id: string;                 // Unique event ID
  name: Name;                 // Event name
  channel: string;            // Channel name
  payload: Payload;           // Event payload
  timestamp: string;          // ISO 8601 timestamp
  meta?: Record<string, any>; // Optional metadata
}
```

### EventOptions

```typescript
interface EventOptions {
  clientEventId?: string;     // Client-provided event ID
  correlationId?: string;     // Correlation ID for tracing
  partitionKey?: string;      // Partition key for ordering
  immediate?: boolean;        // Bypass queue for immediate processing
}
```

## Error Handling

The client provides comprehensive error handling:

```typescript
try {
  const result = await client.publish('user:created', userData);
  if (!result.success) {
    console.error('Publish failed:', result.error);
  }
} catch (error) {
  console.error('Unexpected error:', error);
}
```

## Subscription Management

Subscriptions are automatically tracked and can be managed:

```typescript
// Get subscription count
const count = client.getSubscriptionCount();

// Get all subscriptions
const subscriptions = client.getSubscriptions();

// Clean up specific subscription
await client.unsubscribe(subscriptionId);
```

## Development

### Building

```bash
pnpm run build
```

### Development Mode

```bash
pnpm run dev
```

### Type Checking

```bash
pnpm run check-types
```

### Testing

```bash
pnpm run test
```

## Architecture

The pubsub-client is designed to work seamlessly with the saga-soa ecosystem:

1. **tRPC Integration**: Uses tRPC for type-safe API communication
2. **Event System**: Leverages @saga-ed/pubsub-core for event definitions
3. **Real-time**: Supports both HTTP and WebSocket/SSE connections
4. **Type Safety**: Full TypeScript support with proper type inference

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT
