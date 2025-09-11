# tRPC Pub/Sub Infrastructure Specification (Monorepo-Aligned)

A complete technical specification for a tRPC-based pub/sub infrastructure that integrates seamlessly with the saga-soa monorepo architecture.

## 1. Goals & Assumptions

**Goals**
- Single source of truth for events and payload types
- Typed client experience with generated types
- Support for both server-push (SSE / tRPC subscription) and client-initiated events (CSE)
- Channels with per-channel policies (auth, retention, ordering)
- Pluggable adapters (Redis, Kafka, NATS, in-memory) for publish/subscribe and optional persistence
- **Monorepo Integration**: Leverage existing workspace patterns, build tools, and testing frameworks

**Assumptions**
- TypeScript codebase with ESM modules (`"type": "module"`)
- tRPC v11+ with modern patterns
- `zod` for runtime validation
- `vitest` for testing (monorepo standard)
- `tsup` for builds (monorepo standard)
- `inversify` for dependency injection (existing pattern)
- Workspace dependencies (`workspace:*`) instead of external npm packages

---

## 2. Monorepo Package Structure

```
packages/
  pubsub-core/          # Core interfaces, types, and utilities
    package.json         # ESM, workspace dependencies
    tsconfig.json        # Extends base.json
    vitest.config.ts     # Standard vitest config
    src/
      types/             # Event definitions, interfaces
      adapters/          # Base adapter interfaces
      utils/             # Shared utilities
  
  pubsub-server/         # Server implementation
    package.json         # Depends on pubsub-core, core-api
    tsconfig.json        # Extends base.json
    vitest.config.ts     # Standard vitest config
    src/
      server/            # tRPC procedures, SSE handler
      services/          # Core services with inversify
      adapters/          # Adapter implementations
  
  pubsub-client/         # Client utilities
    package.json         # Depends on pubsub-core
    tsconfig.json        # Extends base.json
    vitest.config.ts     # Standard vitest config
    src/
      client/            # Typed client helpers
      sse/               # SSE connection management
  
  pubsub-adapters/       # Adapter implementations
    package.json         # Depends on pubsub-core
    tsconfig.json        # Extends base.json
    vitest.config.ts     # Standard vitest config
    src/
      in-memory/         # In-memory adapter
      redis/             # Redis adapter
      kafka/             # Kafka adapter
```

---

## 3. Core Data Models (ESM-Compliant)

### 3.1 Event envelope
```ts
// packages/pubsub-core/src/types/event.ts
export type EventName = `${string}:${string}`; // Example: "orders:created"

export interface EventEnvelope<Name extends EventName = EventName, Payload = unknown> {
  id: string;                 // unique id (uuid/v4)
  name: Name;                 // canonical event name
  channel: string;            // logical family, e.g. "orders"
  payload: Payload;
  timestamp: string;          // ISO 8601
  meta?: Record<string, any>; // optional metadata
}
```

### 3.2 Event Definition
```ts
// packages/pubsub-core/src/types/definition.ts
import type { ZodSchema } from 'zod';

export interface EventDefinition<Payload, Result = void> {
  name: string;                       // canonical event name
  channel: string;                    // logical family
  payloadSchema?: ZodSchema<Payload>; // optional runtime schema
  direction?: "SSE" | "CSE" | "BOTH";
  action?: (ctx: ActionCtx, payload: Payload, opts?: ActionOpts) => Promise<Result>;
  description?: string;
  version?: number;
}

export interface ActionCtx {
  user?: { id: string; roles: string[] };
  requestId?: string;
  services: {
    db: DbClient;
    cache?: CacheClient;
    logger: Logger;
    idempotency?: IdempotencyStore;
  };
  emit: (event: EventEnvelope) => Promise<void>;
}
```

---

## 4. Package Implementation Details

### 4.1 pubsub-core Package

**package.json**
```json
{
  "name": "@hipponot/pubsub-core",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./types": {
      "types": "./dist/types/index.d.ts",
      "default": "./dist/types/index.js"
    },
    "./adapters": {
      "types": "./dist/adapters/index.d.ts",
      "default": "./dist/adapters/index.js"
    }
  },
  "scripts": {
    "dev": "tsup --watch",
    "build": "tsup",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "zod": "^4.0.10",
    "uuid": "^11.1.0"
  },
  "devDependencies": {
    "@hipponot/typescript-config": "workspace:*",
    "@types/uuid": "^10.0.0",
    "tsup": "^8.5.0",
    "typescript": "^5.8.3",
    "vitest": "^1.5.0"
  }
}
```

**tsconfig.json**
```json
{
  "extends": "../../packages/typescript-config/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "rootDir": "src",
    "types": ["vitest"]
  },
  "include": ["src"],
  "exclude": ["**/node_modules/**", "dist", "**/__tests__/**/mocks/**"]
}
```

**vitest.config.ts**
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.spec.ts'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/test/**', '**/__tests__/**/mocks/**'],
    },
  },
});
```

### 4.2 pubsub-server Package

**package.json**
```json
{
  "name": "@hipponot/pubsub-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./server": {
      "types": "./dist/server/index.d.ts",
      "default": "./dist/server/index.js"
    },
    "./services": {
      "types": "./dist/services/index.d.ts",
      "default": "./dist/services/index.js"
    }
  },
  "scripts": {
    "dev": "tsup --watch",
    "build": "tsup",
    "test": "vitest run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@hipponot/pubsub-core": "workspace:*",
    "@hipponot/api-core": "workspace:*",
    "@hipponot/logger": "workspace:*",
    "@trpc/server": "^11.0.0",
    "inversify": "^6.2.2",
    "reflect-metadata": "^0.2.2"
  },
  "devDependencies": {
    "@hipponot/typescript-config": "workspace:*",
    "@types/node": "latest",
    "tsup": "^8.5.0",
    "typescript": "^5.8.3",
    "vitest": "^1.5.0"
  }
}
```

---

## 5. Dependency Injection Integration

### 5.1 Service Registration
```ts
// packages/pubsub-server/src/inversify.config.ts
import { Container } from 'inversify';
import { TYPES } from './types';
import { PubSubService } from './services/pubsub.service';
import { EventService } from './services/event.service';
import { ChannelService } from './services/channel.service';

const container = new Container();

container.bind<PubSubService>(TYPES.PubSubService).to(PubSubService);
container.bind<EventService>(TYPES.EventService).to(EventService);
container.bind<ChannelService>(TYPES.ChannelService).to(ChannelService);

export { container };
```

### 5.2 Service Implementation
```ts
// packages/pubsub-server/src/services/pubsub.service.ts
import { inject, injectable } from 'inversify';
import { TYPES } from '../types';
import type { EventService } from './event.service';
import type { ChannelService } from './channel.service';
import type { PubSubAdapter } from '@hipponot/pubsub-core';

@injectable()
export class PubSubService {
  constructor(
    @inject(TYPES.EventService) private eventService: EventService,
    @inject(TYPES.ChannelService) private channelService: ChannelService,
    @inject(TYPES.PubSubAdapter) private adapter: PubSubAdapter
  ) {}

  async publishEvent(event: EventEnvelope): Promise<void> {
    // Implementation
  }
}
```

---

## 6. Testing Strategy

### 6.1 Test Structure
```
packages/pubsub-core/src/__tests__/
  unit/
    types/
      event.test.ts
      definition.test.ts
    adapters/
      base-adapter.test.ts
  integration/
    event-flow.test.ts
  mocks/
    mock-adapter.ts
    mock-event.ts
```

### 6.2 Test Examples
```ts
// packages/pubsub-core/src/__tests__/unit/types/event.test.ts
import { describe, it, expect } from 'vitest';
import type { EventEnvelope, EventName } from '../../types/event';

describe('EventEnvelope', () => {
  it('should create valid event envelope', () => {
    const event: EventEnvelope<'orders:created'> = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'orders:created',
      channel: 'orders',
      payload: { orderId: '123', total: 100 },
      timestamp: new Date().toISOString()
    };

    expect(event.name).toBe('orders:created');
    expect(event.channel).toBe('orders');
  });
});
```

---

## 7. Build Configuration

### 7.1 tsup Configuration
```ts
// packages/pubsub-core/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
```

### 7.2 TypeScript Paths
```json
// packages/pubsub-core/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

---

## 8. Integration with Existing Patterns

### 8.1 Sector Integration
```ts
// apps/examples/trpc-api/src/sectors/pubsub/
import { injectable } from 'inversify';
import { AbstractTRPCController } from '@hipponot/api-core';
import { PubSubService } from '@hipponot/pubsub-server';

@injectable()
export class PubSubController extends AbstractTRPCController {
  constructor(
    private pubSubService: PubSubService
  ) {
    super();
  }

  // tRPC procedures
}
```

### 8.2 Event Definition Pattern
```ts
// apps/examples/trpc-api/src/sectors/orders/events.ts
import { z } from 'zod';
import type { EventDefinition } from '@hipponot/pubsub-core';

export const orderCreatedSchema = z.object({
  orderId: z.string(),
  total: z.number(),
  userId: z.string()
});

export const orderCreated: EventDefinition<
  z.infer<typeof orderCreatedSchema>,
  { success: boolean }
> = {
  name: 'orders:created',
  channel: 'orders',
  payloadSchema: orderCreatedSchema,
  direction: 'BOTH',
  action: async (ctx, payload) => {
    // Implementation
    return { success: true };
  }
};
```

---

## 9. Development Workflow

### 9.1 Adding New Events
1. Create event definition in appropriate sector
2. Add to sector's event index
3. Run tests: `pnpm test` in package
4. Build: `pnpm build` in package
5. Update main API to include new events

### 9.2 Testing New Features
1. Unit tests for individual components
2. Integration tests for event flows
3. Performance tests for high-throughput scenarios
4. Use existing test patterns and mocks

### 9.3 Build Process
1. Individual package builds with tsup
2. Type generation and validation
3. Integration with main monorepo build pipeline
4. Workspace dependency resolution

---

## 10. Migration from Current Spec

### 10.1 Phase 1: Core Infrastructure
- [ ] Create pubsub-core package with types and interfaces
- [ ] Implement base adapter interface
- [ ] Set up testing framework with vitest

### 10.2 Phase 2: Server Implementation
- [ ] Create pubsub-server package
- [ ] Integrate with inversify dependency injection
- [ ] Implement tRPC procedures and SSE handler

### 10.3 Phase 3: Client Utilities
- [ ] Create pubsub-client package
- [ ] Implement typed client helpers
- [ ] Add SSE connection management

### 10.4 Phase 4: Adapters
- [ ] Implement in-memory adapter
- [ ] Add Redis adapter
- [ ] Create Kafka adapter

### 10.5 Phase 5: Integration
- [ ] Integrate with existing trpc-api example
- [ ] Add comprehensive test coverage
- [ ] Performance optimization and monitoring

---

## 11. Benefits of Monorepo Alignment

1. **Consistent Build Process**: All packages use tsup and follow same build patterns
2. **Unified Testing**: vitest across all packages with consistent configuration
3. **Type Safety**: Shared TypeScript configuration and strict type checking
4. **Dependency Management**: Workspace dependencies prevent version conflicts
5. **Development Experience**: Consistent tooling and patterns across packages
6. **Integration**: Seamless integration with existing core-api and sector patterns

---

## 12. Next Steps

1. **Review and approve** this revised specification
2. **Create package structure** following the outlined design
3. **Implement core types** and interfaces
4. **Set up build and test** infrastructure
5. **Integrate with existing** trpc-api example
6. **Add comprehensive testing** and documentation

This revised specification maintains all the technical capabilities of the original while ensuring perfect alignment with your monorepo architecture, ESM compliance, and existing development patterns. 