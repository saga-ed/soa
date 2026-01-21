# @saga-ed/pubsub-core

Core types, interfaces, and utilities for the saga-soa pub/sub infrastructure.

## Overview

This package provides the foundational types and interfaces for building a robust pub/sub system that integrates seamlessly with the saga-soa monorepo architecture.

## Features

- **Type-safe event definitions** with Zod schema validation
- **Flexible event direction** support (SSE, CSE, or both)
- **Pluggable adapter system** for different pub/sub backends
- **Comprehensive testing** with vitest and mock adapters
- **ESM-first design** aligned with monorepo patterns

## Installation

This package is part of the saga-soa workspace and should be used as a workspace dependency:

```json
{
  "dependencies": {
    "@saga-ed/pubsub-core": "workspace:*"
  }
}
```

## Usage

### Basic Event Types

```typescript
import type { EventEnvelope, EventName } from '@saga-ed/pubsub-core';

// Define event names with type safety
type OrderEvents = 'orders:created' | 'orders:updated' | 'orders:cancelled';

// Create event envelopes
const event: EventEnvelope<'orders:created'> = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'orders:created',
  channel: 'orders',
  payload: { orderId: '123', total: 100 },
  timestamp: new Date().toISOString()
};
```

### Event Definitions

```typescript
import { z } from 'zod';
import type { EventDefinition } from '@saga-ed/pubsub-core';

const orderSchema = z.object({
  orderId: z.string(),
  total: z.number(),
  userId: z.string()
});

export const orderCreated: EventDefinition<
  z.infer<typeof orderSchema>,
  { success: boolean }
> = {
  name: 'orders:created',
  channel: 'orders',
  payloadSchema: orderSchema,
  direction: 'BOTH',
  action: async (ctx, payload) => {
    // Server-side action implementation
    return { success: true };
  }
};
```

### Adapter Interface

```typescript
import type { PubSubAdapter, EventEnvelope } from '@saga-ed/pubsub-core';

class MyCustomAdapter implements PubSubAdapter {
  async publish(event: EventEnvelope): Promise<void> {
    // Implementation for publishing events
  }

  async subscribe(channel: string, handler: (event: EventEnvelope) => Promise<void>) {
    // Implementation for subscribing to channels
    return { unsubscribe: async () => {} };
  }
}
```

## Package Structure

```
src/
  types/           # Core type definitions
    event.ts       # Event envelope and metadata types
    definition.ts  # Event definition and action context types
    index.ts       # Type exports
  adapters/        # Adapter interfaces
    base-adapter.ts # Base adapter interface
    index.ts       # Adapter exports
  utils/           # Shared utilities
  __tests__/       # Test suite
    unit/          # Unit tests
    integration/   # Integration tests
    mocks/         # Mock implementations
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

## Build

Build the package:

```bash
pnpm build
```

Watch mode for development:

```bash
pnpm dev
```

## Dependencies

- **zod**: Runtime schema validation
- **uuid**: Unique identifier generation
- **vitest**: Testing framework
- **tsup**: Build tool

## Contributing

1. Follow the monorepo patterns established in saga-soa
2. Use ESM imports and exports
3. Write comprehensive tests for new features
4. Update this README when adding new functionality

## License

Private - part of the saga-soa monorepo 