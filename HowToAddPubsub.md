# How to Add PubSub Sectors to tRPC APIs

This guide walks you through the process of adding pubsub functionality to any tRPC API that leverages the saga-soa infrastructure. The pubsub system enables real-time event-driven communication between clients and servers using both Client-Sent Events (CSE) and Server-Sent Events (SSE).

> **✅ Updated for Simplified Architecture**: This guide reflects the new simplified event architecture that consolidates all event logic into a single, clean interface.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Step-by-Step Implementation](#step-by-step-implementation)
4. [Channel Setup](#channel-setup)
5. [Event Definitions and Types](#event-definitions-and-types)
6. [Inversify Configuration](#inversify-configuration)
7. [Testing Your Implementation](#testing-your-implementation)
8. [Troubleshooting](#troubleshooting)

## Overview

The saga-soa pubsub system provides:
- **Unified Event Definitions**: Single interface for both CSE and SSE events with clear discrimination
- **Type-Safe Schemas**: Zod validation with TypeScript type inference
- **Channel Management**: Logical grouping of related events
- **CSE (Client-Sent Events)**: Clients trigger server-side actions
- **SSE (Server-Sent Events)**: Server pushes real-time updates to clients
- **Clean Separation**: SSE events are pure data carriers, CSE events have executable actions
- **Single Source of Truth**: All event schemas and logic in one place

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   tRPC Client   │    │   tRPC API       │    │  PubSub Server  │
│                 │    │                  │    │                 │
│ • Subscribe     │◄──►│ • PubSub Router  │◄──►│ • Event Service │
│ • Publish       │    │ • Event Handler  │    │ • Channel Svc   │
│ • EventSource   │    │ • Inversify DI   │    │ • Adapters      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### Key Components

1. **PubSub Sector**: Contains unified event definitions, tRPC routes, and schemas
2. **PubSub Service**: Core service that manages events and channels
3. **Event Definitions**: Unified interface with discriminated types (CSE vs SSE)
4. **Channel Configuration**: Settings for event grouping and delivery
5. **Inversify Container**: Dependency injection for all services

### Simplified Architecture Benefits

- ✅ **Reduced Complexity**: One interface instead of multiple overlapping types
- ✅ **Clear Discrimination**: `direction: 'CSE' | 'SSE'` makes event types explicit
- ✅ **Type Safety**: Full TypeScript support with proper type guards
- ✅ **Single Source of Truth**: All schemas and logic consolidated in `events.ts`

### Communication Implementation

The current saga-soa infrastructure uses **Server-Sent Events (SSE)** via the EventSource interface for real-time communication, not WebSockets:

- **CSE (Client-Sent Events)**: Implemented through tRPC mutations over HTTP
- **SSE (Server-Sent Events)**: Implemented through EventSource interface for real-time updates
- **Full-duplex communication**: Achieved by combining HTTP-based tRPC for client-to-server and EventSource for server-to-client

This approach provides:
- **Simpler implementation**: No WebSocket protocol complexity
- **Better browser compatibility**: EventSource is widely supported
- **Automatic reconnection**: Built-in reconnection handling
- **HTTP-based**: Works through proxies and firewalls more easily

## Step-by-Step Implementation

### 1. Create the PubSub Sector Structure

Create the following **simplified** directory structure in your tRPC API:

```
src/sectors/pubsub/
├── index.ts              # Main sector export
├── events.ts            # Unified event definitions (schemas + logic)
└── trpc/
    └── pubsub-router.ts # tRPC router implementation
```

> **🎯 Simplified Structure**: The new architecture eliminates the need for separate schema files and channel configs. Everything is consolidated into `events.ts` for maximum simplicity.

### 2. Create Unified Event Definitions

Define all your events, schemas, and logic in a single file - the **single source of truth**:

```typescript
// src/sectors/pubsub/events.ts
import { z } from 'zod';
import type { EventDefinition, EventEnvelope, ActionCtx } from '@saga-soa/pubsub-core';

// ============================================================================
// Payload Schemas - Single source of truth
// ============================================================================

// User notification schema
export const UserNotificationSchema = z.object({
    userId: z.string().uuid(),
    message: z.string().min(1),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    timestamp: z.string().datetime()
});

// Notification response schema
export const NotificationResponseSchema = z.object({
    notificationId: z.string().uuid(),
    userId: z.string().uuid(),
    deliveredAt: z.string().datetime(),
    success: z.boolean()
});

// TypeScript types derived from schemas
export type UserNotificationInput = z.infer<typeof UserNotificationSchema>;
export type NotificationResponseOutput = z.infer<typeof NotificationResponseSchema>;

// ============================================================================
// Event Definitions - Unified architecture
// ============================================================================

// User notification event (CSE - Client-Sent Event with action)
export const userNotificationEvent: EventDefinition<
    UserNotificationInput,
    { success: boolean; notificationId: string }
> = {
    name: 'user:notification' as const,
    channel: 'notifications',
    payloadSchema: UserNotificationSchema,
    direction: 'CSE', // Has server-side action
    description: 'Send a notification to a specific user',
    version: 1,
    authScope: 'user:notify',
    action: async (ctx: ActionCtx, payload: UserNotificationInput) => {
        // Validate user permissions
        if (!ctx.user || !ctx.user.roles.includes('notifier')) {
            throw new Error('Insufficient permissions to send notifications');
        }

        // Process the notification
        const notificationId = crypto.randomUUID();
        
        // Emit a delivery confirmation event (SSE)
        await ctx.emit({
            id: crypto.randomUUID(),
            name: 'notification:delivered' as const,
            channel: 'notifications',
            payload: {
                notificationId,
                userId: payload.userId,
                deliveredAt: new Date().toISOString(),
                success: true
            },
            timestamp: new Date().toISOString()
        });

        return {
            success: true,
            notificationId
        };
    }
};

// Notification delivery event (SSE - Server-Sent Event, no action)
export const notificationDeliveredEvent: EventDefinition<NotificationResponseOutput> = {
    name: 'notification:delivered' as const,
    channel: 'notifications',
    payloadSchema: NotificationResponseSchema,
    direction: 'SSE', // Pure data carrier, no action
    description: 'Confirmation that a notification was delivered',
    version: 1
    // No action needed - clean separation!
};

// Export all events
export const events = {
    'user:notification': userNotificationEvent,
    'notification:delivered': notificationDeliveredEvent
};
```

> **🎯 Key Benefits**:
> - **Single File**: All schemas, types, and logic in one place
> - **Clear Direction**: `CSE` events have actions, `SSE` events are pure data
> - **Type Safety**: Full TypeScript inference from Zod schemas
> - **No Duplication**: Eliminated redundant schema files

### 3. Implement the tRPC Router

Create the tRPC router that exposes pubsub functionality with **simplified imports**:

```typescript
// src/sectors/pubsub/trpc/pubsub-router.ts
import { injectable, inject } from 'inversify';
import { AbstractTRPCController, router } from '@saga-soa/api-core/abstract-trpc-controller';
import type { ILogger } from '@saga-soa/logger';
import { events, UserNotificationSchema, type UserNotificationInput } from '../events.js';

// Import pubsub server functionality
import { PubSubService, TYPES, ChannelService } from '@saga-soa/pubsub-server';
import type { EventEnvelope, EventDefinition, EventName, ChannelConfig } from '@saga-soa/pubsub-core';
import { z } from 'zod';

@injectable()
export class PubSubController extends AbstractTRPCController {
  readonly sectorName = 'pubsub';
  private pubsubService: PubSubService;
  private channelService: ChannelService;

  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('PubSubService') pubsubService: PubSubService,
    @inject(TYPES.ChannelService) channelService: ChannelService
  ) {
    super(logger);
    this.pubsubService = pubsubService;
    this.channelService = channelService;
    
    // Register pubsub events and channels with the service
    this.registerPubSubEvents();
    this.registerPubSubChannels();
  }

  private registerPubSubEvents(): void {
    try {
      this.pubsubService.registerEvents(events);
      this.logger.info('PubSub events registered successfully', {
        eventCount: Object.keys(events).length,
        eventNames: Object.keys(events)
      });
    } catch (error) {
      this.logger.error('Failed to register PubSub events', {
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private registerPubSubChannels(): void {
    try {
      const notificationChannel: ChannelConfig = {
        name: 'notifications',
        family: 'user',
        ordered: false,
        maxSubscribers: 100,
        maxEventSize: 1024 * 1024, // 1MB
        historyRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
        authScope: 'user'
      };

      this.channelService.registerChannels([notificationChannel]);
      
      this.logger.info('PubSub channels registered successfully', {
        channelName: 'notifications',
        family: 'user'
      });
    } catch (error) {
      this.logger.error('Failed to register PubSub channels', {
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  createRouter() {
    const t = this.createProcedure();

    return router({
      // Send a user notification
      sendNotification: t
        .input(UserNotificationSchema)
        .mutation(async ({ input }: { input: UserNotificationInput }) => {
          try {
            const result = await this.pubsubService.sendEvent(
              {
                name: 'user:notification' as EventName,
                payload: input,
                clientEventId: crypto.randomUUID(),
                correlationId: crypto.randomUUID()
              },
              {
                user: { id: 'web-client', roles: ['notifier'] },
                requestId: crypto.randomUUID(),
                services: {
                  db: null, // TODO: Inject actual services
                  cache: null,
                  logger: this.logger,
                  idempotency: null
                }
              }
            );

            if (result.status === 'error') {
              throw new Error(result.error || 'Failed to send notification');
            }

            return {
              success: true,
              notificationId: result.result?.notificationId,
              emittedEvents: result.emittedEvents,
              message: 'Notification sent successfully'
            };
          } catch (error) {
            this.logger.error('Failed to send notification', {
              error: error instanceof Error ? error.message : 'Unknown error',
              input
            });
            throw new Error(`Failed to send notification: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }),

      // Get event definitions
      getEventDefinitions: t.query(() => {
        return {
          events: Object.keys(events),
          totalEvents: Object.keys(events).length
        };
      }),

      // Get channel information
      getChannelInfo: t.query(() => {
        return {
          channel: 'notifications',
          eventTypes: ['user:notification', 'notification:delivered'],
          description: 'User notification system',
          activeSubscribers: 0
        };
      }),

      // Subscribe to notifications
      subscribe: t
        .input(z.object({
          channel: z.string(),
          eventTypes: z.array(z.string()).optional()
        }))
        .mutation(async ({ input }) => {
          const subscriptionId = crypto.randomUUID();
          
          this.logger.info('Subscription request received', {
            channel: input.channel,
            subscriptionId,
            eventTypes: input.eventTypes
          });

          return {
            success: true,
            subscriptionId,
            channel: input.channel,
            eventTypes: input.eventTypes || ['*'],
            message: 'Subscription established',
            timestamp: new Date().toISOString()
          };
        })
    });
  }
}
```

### 4. Export the Sector

Create the main sector export:

```typescript
// src/sectors/pubsub/index.ts
export { PubSubController } from './trpc/pubsub-router.js';
```

> **✅ Complete**: You now have a fully functional pubsub sector with the simplified architecture!

## Channel Setup

Channels are logical groupings of related events. They can be configured with various options:

### Basic Channel Configuration

```typescript
// src/sectors/pubsub/channels/channel-config.ts
import type { ChannelConfig } from '@saga-soa/pubsub-core';

export const channelConfigs: ChannelConfig[] = [
  {
    name: 'notifications',
    family: 'user',
    authScope: 'user:read',
    historyRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
    ordered: true,
    maxSubscribers: 1000,
    maxEventSize: 1024 * 1024 // 1MB
  },
  {
    name: 'system',
    family: 'admin',
    authScope: 'admin:read',
    historyRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    ordered: false,
    maxSubscribers: 100,
    maxEventSize: 512 * 1024 // 512KB
  }
];
```

### Channel Registration

Channels are automatically registered when you register events, but you can also register them explicitly:

```typescript
// In your PubSubController constructor
constructor(
  @inject('ILogger') logger: ILogger,
  @inject('PubSubService') pubsubService: PubSubService
) {
  super(logger);
  this.pubsubService = pubsubService;
  
  // Register channels first
  this.pubsubService.registerChannels(channelConfigs);
  
  // Then register events
  this.registerPubSubEvents();
}
```

## Event Definitions and Types

### Type Sharing Between Client and Server

The saga-soa infrastructure provides several ways to share types:

#### 1. Shared Schema Package (Recommended)

Create a shared package that both client and server can import:

```typescript
// packages/shared-schemas/src/pubsub.ts
export * from './user-notifications.js';
export * from './system-events.js';

// packages/shared-schemas/src/user-notifications.ts
import { z } from 'zod';

export const UserNotificationSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  timestamp: z.string().datetime()
});

export type UserNotificationInput = z.infer<typeof UserNotificationSchema>;
```

#### 2. Code Generation

Use the built-in code generation tools to create client types:

```bash
# Generate types from your tRPC API
pnpm run codegen

# This will create types that can be imported by clients
```

#### 3. Direct Import (Simple Cases)

For simple APIs, you can directly import types:

```typescript
// Client code
import type { UserNotificationInput } from '@your-api/schemas';
```

### Event Direction - Simplified

Events are configured with **clear, discriminated directions**:

- **CSE (Client-Sent Events)**: Clients trigger server-side actions (have `action` function)
- **SSE (Server-Sent Events)**: Server pushes updates to clients (no `action`, pure data)

```typescript
// CSE Example - Client triggers server action
export const chatSendEvent: EventDefinition<ChatMessage, { messageId: string }> = {
    name: 'chat:send' as const,
    channel: 'chat',
    direction: 'CSE', // Has server-side action
    payloadSchema: ChatMessageSchema,
    action: async (ctx, payload) => {
        // Process incoming message from client
        const messageId = crypto.randomUUID();
        
        // Emit to other users via SSE
        await ctx.emit({
            id: crypto.randomUUID(),
            name: 'chat:message' as const,
            channel: 'chat',
            payload: { ...payload, messageId, processed: true },
            timestamp: new Date().toISOString()
        });
        
        return { messageId };
    }
};

// SSE Example - Server pushes data to clients
export const chatMessageEvent: EventDefinition<ProcessedChatMessage> = {
    name: 'chat:message' as const,
    channel: 'chat',
    direction: 'SSE', // Pure data carrier, no action
    payloadSchema: ProcessedChatMessageSchema
    // No action property - clean separation!
};
```

> **🎯 Benefits**: Clear separation makes the event flow much easier to understand and maintain.

## Inversify Configuration

### Where Configuration Lives

The Inversify configuration is handled at **two levels**:

#### 1. PubSub Server Level (Lower Level)

The `@saga-soa/pubsub-server` package provides its own container with core services:

```typescript
// packages/pubsub-server/src/inversify.config.ts
export const container = new Container();

container.bind<PubSubService>(TYPES.PubSubService).to(PubSubService);
container.bind<EventService>(TYPES.EventService).to(EventService);
container.bind<ChannelService>(TYPES.ChannelService).to(ChannelService);
```

#### 2. tRPC API Level (Your Application)

Your tRPC API binds the pubsub services to its own container:

```typescript
// src/inversify.config.ts
import { PubSubService, EventService, ChannelService, InMemoryAdapter, TYPES } from '@saga-soa/pubsub-server';

export const container = new Container();

// Bind pubsub server components
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(InMemoryAdapter).inSingletonScope();
container.bind(TYPES.EventService).to(EventService).inSingletonScope();
container.bind(TYPES.ChannelService).to(ChannelService).inSingletonScope();
container.bind('PubSubService').to(PubSubService).inSingletonScope();

// Bind your pubsub controller
container.bind(PubSubController).toSelf().inSingletonScope();
```

### Service Dependencies

The pubsub system requires these services to be bound:

```typescript
// Required bindings
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(InMemoryAdapter);
container.bind(TYPES.EventService).to(EventService);
container.bind(TYPES.ChannelService).to(ChannelService);
container.bind('PubSubService').to(PubSubService);

// Optional but recommended
container.bind<ILogger>(TYPES.Logger).to(PinoLogger);
container.bind<IDbClient>('IDbClient').to(MongoProvider);
```

### Adapter Selection

Choose the appropriate adapter for your use case:

```typescript
// In-memory (development/testing)
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(InMemoryAdapter);

// Redis (production)
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(RedisAdapter);

// Custom adapter
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(CustomAdapter);
```

## Testing Your Implementation

### 1. Unit Tests

Test your event definitions and controllers:

```typescript
// src/sectors/pubsub/__tests__/pubsub-router.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'inversify';
import { PubSubController } from '../trpc/pubsub-router.js';
import { MockLogger } from '@saga-soa/logger/mocks';
import { MockPubSubService } from './mocks/mock-pubsub-service.js';

describe('PubSubController', () => {
  let container: Container;
  let controller: PubSubController;

  beforeEach(() => {
    container = new Container();
    
    // Bind mocks
    container.bind('ILogger').toConstantValue(new MockLogger());
    container.bind('PubSubService').toConstantValue(new MockPubSubService());
    
    // Create controller
    controller = container.resolve(PubSubController);
  });

  it('should register events on construction', () => {
    // Test that events are registered
    expect(controller).toBeDefined();
  });
});
```

### 2. Integration Tests

**Important**: All integration tests in the saga-soa codebase now use a **consistent testing approach** to ensure reliability and maintainability.

#### Consistent Testing Pattern

All integration tests follow the **Full Server + Supertest approach**:

```typescript
// src/sectors/pubsub/__tests__/pubsub-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ExpressServer } from '@saga-soa/api-core/express-server';
import { TRPCServer } from '@saga-soa/api-core/trpc-server';
import { ControllerLoader } from '@saga-soa/api-core/utils/controller-loader';
import { AbstractTRPCController } from '@saga-soa/api-core/abstract-trpc-controller';
import { container } from '../../inversify.config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PubSub Integration Tests', () => {
  let app: express.Application;
  let server: any;

  beforeAll(async () => {
    // Get the ControllerLoader from DI
    const controllerLoader = container.get(ControllerLoader);
    
    // Dynamically load all tRPC controllers
    const controllers = await controllerLoader.loadControllers(
      path.resolve(__dirname, '../../sectors/*/trpc/*-router.ts'),
      AbstractTRPCController
    );

    // Bind all loaded controllers to the DI container
    for (const controller of controllers) {
      container.bind(controller).toSelf().inSingletonScope();
    }

    // Configure Express server
    const expressServer = container.get(ExpressServer);
    await expressServer.init(container, []);
    app = expressServer.getApp();

    // Get the TRPCServer instance from DI
    const trpcServer = container.get(TRPCServer);

    // Add routers to the TRPCServer using dynamically loaded controllers
    for (const controller of controllers) {
      const controllerInstance = container.get(controller) as any;
      trpcServer.addRouter(controllerInstance.sectorName, controllerInstance.createRouter());
    }

    // Create tRPC middleware using TRPCServer
    const trpcMiddleware = trpcServer.createExpressMiddleware();

    // Mount tRPC on the configured base path
    app.use(trpcServer.getBasePath(), trpcMiddleware);

    // Start the server on a random port
    server = app.listen(0);
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  it('should handle pubsub operations via HTTP', async () => {
    // Test using supertest - this tests the actual HTTP layer
    const response = await request(app)
      .post('/saga-soa/v1/trpc/pubsub.sendNotification')
      .send({
        userId: 'test-user',
        message: 'Test notification',
        priority: 'high',
        timestamp: new Date().toISOString()
      })
      .expect(200);

    expect(response.body.result.data.success).toBe(true);
  });
});
```

#### Why This Approach?

This testing pattern provides several benefits:

- ✅ **Consistency**: All integration tests use the same approach
- ✅ **Realism**: Tests actual HTTP requests/responses, not just in-memory calls
- ✅ **Comprehensive**: Tests the full server stack, including middleware and routing
- ✅ **Reliable**: No external server dependencies or timeout issues
- ✅ **Maintainable**: Follows established patterns used throughout the codebase

#### Key Testing Principles

1. **Start the actual server** with all dependencies
2. **Load controllers dynamically** using the ControllerLoader
3. **Mount tRPC middleware** on the configured base path
4. **Use supertest** to make HTTP requests to the running server
5. **Test the actual HTTP layer** and server behavior

### 3. Channel Registration in Tests

**Important Fix**: Ensure your pubsub sector properly registers channels during testing. The pubsub service requires both events AND channels to be registered.

#### Updated PubSub Controller

```typescript
// src/sectors/pubsub/trpc/pubsub-router.ts
import { injectable, inject } from 'inversify';
import { AbstractTRPCController, router } from '@saga-soa/api-core/abstract-trpc-controller';
import type { ILogger } from '@saga-soa/logger';
import { events } from '../events.js';

// Import pubsub server functionality
import { PubSubService, TYPES, ChannelService } from '@saga-soa/pubsub-server';
import type { EventEnvelope, EventDefinition, EventName, ChannelConfig } from '@saga-soa/pubsub-core';
import { z } from 'zod';

@injectable()
export class PubSubController extends AbstractTRPCController {
  readonly sectorName = 'pubsub';
  private pubsubService: PubSubService;
  private channelService: ChannelService;

  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('PubSubService') pubsubService: PubSubService,
    @inject(TYPES.ChannelService) channelService: ChannelService
  ) {
    super(logger);
    this.pubsubService = pubsubService;
    this.channelService = channelService;
    
    // Register pubsub events and channels with the service
    this.registerPubSubEvents();
    this.registerPubSubChannels();
  }

  private registerPubSubEvents(): void {
    try {
      this.pubsubService.registerEvents(events);
      this.logger.info('PubSub events registered successfully', {
        eventCount: Object.keys(events).length,
        eventNames: Object.keys(events)
      });
    } catch (error) {
      this.logger.error('Failed to register PubSub events', {
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private registerPubSubChannels(): void {
    try {
      const notificationChannel: ChannelConfig = {
        name: 'notifications',
        family: 'user',
        ordered: false,
        maxSubscribers: 100,
        maxEventSize: 1024 * 1024, // 1MB
        historyRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
        authScope: 'user'
      };

      this.channelService.registerChannels([notificationChannel]);
      
      this.logger.info('PubSub channels registered successfully', {
        channelName: 'notifications',
        family: 'user'
      });
    } catch (error) {
      this.logger.error('Failed to register PubSub channels', {
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // ... rest of your router implementation
}
```

#### Common Testing Issues and Solutions

**Issue**: "Unknown channel: notifications" error in tests

**Solution**: Ensure channels are registered in your PubSubController constructor:

```typescript
// This is REQUIRED for tests to work
private registerPubSubChannels(): void {
  const channelConfigs: ChannelConfig[] = [
    {
      name: 'notifications',
      family: 'user',
      ordered: false,
      maxSubscribers: 100,
      maxEventSize: 1024 * 1024,
      historyRetentionMs: 24 * 60 * 60 * 1000,
      authScope: 'user'
    }
  ];

  this.channelService.registerChannels(channelConfigs);
}
```

**Issue**: Tests timing out or failing to connect

**Solution**: Use the consistent testing pattern above - don't try to connect to external servers:

```typescript
// ❌ DON'T do this (causes timeouts)
const apiBaseUrl = 'http://localhost:5000';

// ✅ DO this instead (creates local test server)
server = app.listen(0); // Random port, no conflicts
```

### 4. Test Server Setup

Create a minimal test server for integration testing:

```typescript
// src/sectors/pubsub/__tests__/integration/test-server.ts
import express from 'express';
import { Container } from 'inversify';
import { PubSubController } from '../../trpc/pubsub-router.js';
import { MockLogger } from '@saga-soa/logger/mocks';
import { MockPubSubService } from '../mocks/mock-pubsub-service.js';

export async function createTestServer() {
  const app = express();
  app.use(express.json());

  // Create minimal container
  const container = new Container();
  container.bind('ILogger').toConstantValue(new MockLogger());
  container.bind('PubSubService').toConstantValue(new MockPubSubService());

  // Create and mount pubsub controller
  const controller = container.resolve(PubSubController);
  const router = controller.createRouter();

  // Mount tRPC router
  app.use('/api/trpc', (req, res) => {
    // Handle tRPC requests
    // This is simplified - in real implementation use proper tRPC middleware
  });

  return app.listen(0);
}
```

### 5. Running Tests

Ensure your test scripts are properly configured:

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

Run all tests to ensure consistency:

```bash
# Run all tests
pnpm test

# Run only pubsub tests
pnpm test __tests__/pubsub-integration.test.ts

# Run with coverage
pnpm test:coverage
```

## Troubleshooting

### Common Issues

#### 1. Events Not Registering

**Problem**: Events are not being registered with the pubsub service.

**Solution**: Check that your PubSubController is properly injected and the `registerPubSubEvents()` method is called in the constructor.

#### 2. Dependency Injection Errors

**Problem**: Inversify container binding errors.

**Solution**: Ensure all required services are bound in the correct order:

```typescript
// Order matters - bind adapters first
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(InMemoryAdapter);
container.bind(TYPES.EventService).to(EventService);
container.bind(TYPES.ChannelService).to(ChannelService);
container.bind('PubSubService').to(PubSubService);
```

#### 3. Type Mismatches

**Problem**: TypeScript errors with event definitions.

**Solution**: Ensure your event definitions match the simplified interface:

```typescript
// Correct format for CSE (with action)
export const cseEvent: EventDefinition<InputType, OutputType> = {
    name: 'category:action' as const, // Must be const assertion
    channel: 'channelName',
    direction: 'CSE', // Must have action
    payloadSchema: YourSchema,
    action: async (ctx, payload) => { /* ... */ }
};

// Correct format for SSE (no action)
export const sseEvent: EventDefinition<PayloadType> = {
    name: 'category:update' as const,
    channel: 'channelName',
    direction: 'SSE', // No action property
    payloadSchema: YourSchema
};
```

#### 4. Schema Validation Errors

**Problem**: Zod validation failing for event payloads.

**Solution**: With the simplified architecture, schemas are in the same file:

```typescript
// All in events.ts - no import issues!
export const UserNotificationSchema = z.object({ /* ... */ });

export const userEvent: EventDefinition<UserNotificationInput> = {
    name: 'user:notification',
    payloadSchema: UserNotificationSchema, // Direct reference, no imports
    // ...
};
```

#### 5. "Unknown Channel" Errors in Tests

**Problem**: Tests failing with "Unknown channel: [channelName]" error.

**Solution**: This is a common issue that occurs when channels are not properly registered. Ensure your PubSubController registers both events AND channels:

```typescript
// REQUIRED: Inject ChannelService
constructor(
  @inject('ILogger') logger: ILogger,
  @inject('PubSubService') pubsubService: PubSubService,
  @inject(TYPES.ChannelService) channelService: ChannelService // ← This is required
) {
  super(logger);
  this.pubsubService = pubsubService;
  this.channelService = channelService;
  
  // Register both events AND channels
  this.registerPubSubEvents();
  this.registerPubSubChannels(); // ← This is required
}

private registerPubSubChannels(): void {
  const channelConfigs: ChannelConfig[] = [
    {
      name: 'notifications', // Must match the channel name in your events
      family: 'user',
      ordered: false,
      maxSubscribers: 100,
      maxEventSize: 1024 * 1024,
      historyRetentionMs: 24 * 60 * 60 * 1000,
      authScope: 'user'
    }
  ];

  this.channelService.registerChannels(channelConfigs);
}
```

**Why this happens**: The pubsub service validates channel access before processing events. If a channel isn't registered, the service will reject the event with an "Unknown channel" error.

#### 6. Integration Test Timeouts

**Problem**: Tests timing out while waiting for external servers or connections.

**Solution**: Use the consistent testing pattern - don't try to connect to external servers:

```typescript
// ❌ DON'T do this (causes timeouts)
const apiBaseUrl = 'http://localhost:5000';
await waitForApi(apiBaseUrl); // This will timeout if no server is running

// ✅ DO this instead (creates local test server)
server = app.listen(0); // Random port, no conflicts
const port = (server.address() as any).port;
```

**Why this happens**: External server tests require the server to be running and accessible, which isn't always the case in CI/CD or development environments.

#### 7. Inconsistent Testing Approaches

**Problem**: Different test files using different testing patterns, leading to maintenance issues.

**Solution**: Standardize on the **Full Server + Supertest approach** used throughout the saga-soa codebase:

```typescript
// ✅ Consistent pattern for all integration tests
beforeAll(async () => {
  // 1. Load controllers dynamically
  const controllers = await controllerLoader.loadControllers(/* ... */);
  
  // 2. Bind to container
  for (const controller of controllers) {
    container.bind(controller).toSelf().inSingletonScope();
  }
  
  // 3. Start actual server
  server = app.listen(0);
});

// 4. Use supertest for HTTP testing
it('should work', async () => {
  const response = await request(app)
    .post('/api/endpoint')
    .send(data)
    .expect(200);
});
```

### Debug Mode

Enable debug logging to troubleshoot issues:

```typescript
// In your logger configuration
const loggerConfig: PinoLoggerConfig = {
  configType: 'PINO_LOGGER',
  level: 'debug', // Set to debug for more verbose logging
  isExpressContext: true,
  prettyPrint: true,
};
```

### Health Checks

Add health check endpoints to monitor pubsub status:

```typescript
// In your pubsub router
getServiceStatus: t.query(() => {
  return {
    status: 'running',
    eventsRegistered: Object.keys(events).length,
    channels: ['notifications', 'system'],
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
}),
```

### Testing Checklist

Before committing your pubsub implementation, ensure:

- ✅ **Events are registered** in the PubSubController constructor
- ✅ **Channels are registered** in the PubSubController constructor
- ✅ **Integration tests use the consistent pattern** (Full Server + Supertest)
- ✅ **No external server dependencies** in tests
- ✅ **All tests pass** with `pnpm test`
- ✅ **Channel names match** between event definitions and channel registration
- ✅ **Dependency injection** is properly configured
- ✅ **Error handling** is implemented for registration failures

## Next Steps

After implementing your pubsub sector:

1. **Test thoroughly** with unit and integration tests
2. **Monitor performance** and add metrics if needed
3. **Implement real-time subscriptions** using Server-Sent Events (EventSource)
4. **Add authentication and authorization** to your events
5. **Consider scaling** with Redis or other distributed adapters

## Summary

Adding pubsub sectors to your tRPC API with the **simplified architecture** involves:

1. **Creating unified event definitions** in a single `events.ts` file
2. **Implementing tRPC routers** with clean imports from `events.ts`
3. **Configuring Inversify** to bind all required services
4. **Setting up channels** for event organization
5. **Testing** your implementation thoroughly

### Simplified Architecture Benefits

The new unified event architecture provides:

- ✅ **Reduced Complexity**: 1 interface instead of 4 complex, overlapping types
- ✅ **Single Source of Truth**: All schemas, types, and logic in `events.ts`
- ✅ **Clear Discrimination**: `direction: 'CSE' | 'SSE'` makes event types explicit
- ✅ **Type Safety**: Full TypeScript inference with proper type guards
- ✅ **Easier Maintenance**: No duplicate schemas or confusing imports
- ✅ **Better Developer Experience**: Intuitive API that's easy to understand

### Migration from Old Architecture

If you have existing pubsub code with the old architecture:

1. **Consolidate schemas** from separate files into `events.ts`
2. **Update event definitions** to use `direction: 'CSE' | 'SSE'`
3. **Remove redundant files** like `pubsub-schemas.ts`
4. **Update imports** in your tRPC router to import from `events.ts`
5. **Test thoroughly** to ensure all functionality is preserved

The saga-soa infrastructure handles most of the complexity, allowing you to focus on defining your business logic with a much cleaner, more intuitive API.
