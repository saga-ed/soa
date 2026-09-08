> Reference. Verified against code 2026-09-08 — package names, the action/context
> API, tRPC wiring, and the testing pattern corrected against
> `apps/node/trpc-api/src/sectors/pubsub/`. See the promotion commit for the
> corrections table.

# How to Add PubSub Sectors to tRPC APIs

This guide walks through adding pubsub functionality to a tRPC API built on saga-soa
infrastructure. The pubsub system enables event-driven communication between clients
and servers: Client-Sent Events (CSE, a client triggers a server-side action) and
Server-Sent Events (SSE, the server pushes data to subscribed clients).

## Overview

- **Unified event definitions**: `CSEEvent`, `SSEEvent`, and `CSEEventWithResponse` —
  a discriminated union keyed on `direction: 'CSE' | 'SSE'` — all live in
  `@saga-ed/soa-pubsub-core`.
- **Type-safe schemas**: each event carries an optional Zod `payloadSchema`.
- **Channel management**: `ChannelConfig` groups related events (subscriber limits,
  event-size caps, history retention, an `authScope`).
- **CSE actions are optional and server-side**: a `CSEEvent`'s `action` is an
  `AbsAction` object (`{ requestId, act(payload, context?) }`) that runs when
  the event is sent. `SSEEvent`s are pure data — no `action`.
- **Communication is HTTP-based, not WebSocket**: CSE via tRPC mutations, SSE via the
  browser `EventSource` interface.

## Architecture

```
┌─────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│   tRPC Client   │    │  tRPC Router (ctx)   │    │  PubSubService    │
│                 │    │                       │    │                    │
│ • mutation call │◄──►│ • ctx.pubsubService   │◄──►│ • EventService     │
│ • EventSource   │    │   .sendEvent(...)     │    │   (validate/authz) │
└─────────────────┘    └──────────────────────┘    │ • ChannelService   │
                                                       │ • Adapter (deliver)│
                                                       └──────────────────┘
```

Events and channels are registered **once at process bootstrap** (`main.ts`), not
per-request and not in a controller constructor — there is no per-sector pubsub
controller class.

## Packages

| Package | Provides |
|---|---|
| `@saga-ed/soa-pubsub-core` | Types — `CSEEvent`, `SSEEvent`, `CSEEventWithResponse`, `EventDefinition`, `ChannelConfig`, `EventEnvelope`, `ActionContext`, `AbsAction`, `EventName` |
| `@saga-ed/soa-pubsub-server` | `PubSubService`, `EventService`, `ChannelService`, `InMemoryAdapter`, `TYPES` (Inversify binding symbols) |
| `@saga-ed/soa-pubsub-client` | Browser-side subscribe/publish client (not covered by this guide) |

## Step-by-Step Implementation

### 1. Directory structure

```
src/sectors/pubsub/trpc/
├── index.ts               # Barrel export
├── events.ts               # Event + action definitions
├── pubsub-router.ts        # tRPC router
└── schema/
    └── pubsub-schemas.ts   # Zod input/output schemas
```

### 2. Define your Zod schemas

```typescript
// src/sectors/pubsub/trpc/schema/pubsub-schemas.ts
import { z } from 'zod';

export const PingMessageSchema = z.object({
    message: z.string().min(1, 'Message cannot be empty'),
    timestamp: z.string()
});

export const PongResponseSchema = z.object({
    reply: z.string(),
    originalMessage: z.string(),
    timestamp: z.string()
});

export type PingMessageZ = z.infer<typeof PingMessageSchema>;
export type PongResponseZ = z.infer<typeof PongResponseSchema>;
```

### 3. Define events and their actions

`CSEEvent.action` is an **`AbsAction` object**, not a bare function — it carries a
`requestId` and an `act(payload, context?)` method. Pair a CSE event with the SSE
event it triggers via `CSEEventWithResponse`'s `responseEvent` field, and push that
SSE event with `context.emitSSE(name, payload, options)` from inside `act()`:

```typescript
// src/sectors/pubsub/trpc/events.ts
import type { EventEnvelope, CSEEvent, SSEEvent, CSEEventWithResponse, ActionContext } from '@saga-ed/soa-pubsub-core';
import { PingMessageSchema, PongResponseSchema, type PingMessageZ, type PongResponseZ } from './schema/pubsub-schemas.js';

// SSE event — pure data carrier, no action
export const pongEvent: SSEEvent<PongResponseZ> = {
    name: 'pong:response' as const,
    channel: 'pingpong',
    payloadSchema: PongResponseSchema,
    direction: 'SSE',
    description: 'Pong response sent when a ping is received',
    version: 1
};

// CSE event with a linked response — the action runs server-side, then emits the SSE event
export const pingEvent: CSEEventWithResponse<PingMessageZ, PongResponseZ, typeof pongEvent> = {
    name: 'ping:message' as const,
    channel: 'pingpong',
    payloadSchema: PingMessageSchema,
    direction: 'CSE',
    description: 'Ping message that triggers a pong response',
    version: 1,
    responseEvent: pongEvent,
    action: {
        requestId: crypto.randomUUID(),
        responseEventType: 'pong:response',
        async act(payload: PingMessageZ, context?: ActionContext): Promise<PongResponseZ> {
            const pongResponse: PongResponseZ = {
                reply: `Pong: ${payload.message}`,
                originalMessage: payload.message,
                timestamp: new Date().toISOString()
            };
            if (context) {
                await context.emitSSE('pong:response', pongResponse, {
                    channel: 'pingpong',
                    correlationId: context.requestId
                });
            }
            return pongResponse;
        }
    }
};

// CSE event with no response — fire-and-forget
export const logEvent: CSEEvent<{ message: string; level: string }> = {
    name: 'system:log' as const,
    channel: 'system',
    direction: 'CSE',
    version: 1,
    action: {
        requestId: crypto.randomUUID(),
        async act(payload: { message: string; level: string }, context?: ActionContext) {
            context?.logger?.info(`[${payload.level}] ${payload.message}`);
        }
    }
};

export const events = {
    'ping:message': pingEvent,
    'pong:response': pongEvent,
    'system:log': logEvent
};
```

### 4. Build the tRPC router

There is **no pubsub controller class**. Use the plain `router`/`publicProcedure`
factory your app already exports from its `trpc.ts` (built on
`createTRPCBase<TRPCContext>()` from `@saga-ed/soa-trpc-base`), and reach the pubsub
service through the shared tRPC `ctx` — it's injected once at bootstrap, not per-sector:

```typescript
// src/sectors/pubsub/trpc/pubsub-router.ts
import { router, publicProcedure } from '../../../trpc.js';
import { events } from './events.js';
import { PingMessageSchema } from './schema/pubsub-schemas.js';
import { z } from 'zod';

export const pubsubRouter = router({
    ping: publicProcedure
        .input(PingMessageSchema)
        .mutation(async ({ ctx, input }) => {
            const eventId = crypto.randomUUID();
            const result = await ctx.pubsubService.sendEvent(
                { name: 'ping:message', payload: input, clientEventId: eventId, correlationId: eventId },
                {
                    user: { id: 'web-client', roles: ['user'] },
                    requestId: eventId,
                    services: { db: null, cache: null, logger: ctx.logger, idempotency: null }
                }
            );
            if (result.status === 'error') {
                throw new Error(result.error || 'Failed to send ping event');
            }
            return { success: true, message: `Ping sent: "${input.message}"`, pubsubResult: result };
        }),

    getEventDefinitions: publicProcedure.query(() => ({
        events: Object.keys(events),
        totalEvents: Object.keys(events).length
    }))
});
```

`ctx.pubsubService.sendEvent(input, serverCtx)` — `input` is
`{ name, payload, clientEventId?, correlationId? }`; `serverCtx` is
`{ user, requestId, services: { db, cache, logger, idempotency } }` (only `logger`
is commonly populated by callers today — the rest are placeholders for services
an action might need).

### 5. Register events and channels once, at bootstrap

Registration happens **once in `main.ts`**, after the Inversify container is built
and before the server starts listening — not in a per-sector constructor:

```typescript
// src/main.ts
import { PubSubService, TYPES, ChannelService } from '@saga-ed/soa-pubsub-server';
import type { EventDefinition, ChannelConfig } from '@saga-ed/soa-pubsub-core';
import { events } from './sectors/pubsub/trpc/events.js';

const pubsubService = container.get<PubSubService>('PubSubService');
const channelService = container.get<ChannelService>(TYPES.ChannelService);

pubsubService.registerEvents(events as unknown as Record<string, EventDefinition>);

const pingpongChannel: ChannelConfig = {
    name: 'pingpong',
    family: 'demo',
    ordered: false,
    maxSubscribers: 100,
    maxEventSize: 1024 * 1024,
    historyRetentionMs: 24 * 60 * 60 * 1000,
    authScope: 'user'
};
channelService.registerChannels([pingpongChannel]);
```

### 6. Wire the router and context

```typescript
// src/app-router.ts
import { router } from './trpc.js';
import { pubsubRouter } from './sectors/pubsub/trpc/pubsub-router.js';

export const appRouter = router({ pubsub: pubsubRouter /* , ...other sectors */ });
export type AppRouter = typeof appRouter;
```

```typescript
// src/trpc.ts
import { createTRPCBase } from '@saga-ed/soa-trpc-base';
import type { ILogger } from '@saga-ed/soa-logger';
import type { PubSubService, ChannelService } from '@saga-ed/soa-pubsub-server';

export interface TRPCContext {
    logger: ILogger;
    pubsubService: PubSubService;
    channelService: ChannelService;
}

const t = createTRPCBase<TRPCContext>();
export const router = t.router;
export const publicProcedure = t.publicProcedure;
```

## Channel Setup

```typescript
import type { ChannelConfig } from '@saga-ed/soa-pubsub-core';

export const channelConfigs: ChannelConfig[] = [
  {
    name: 'notifications',
    family: 'user',
    authScope: 'user:read',
    historyRetentionMs: 24 * 60 * 60 * 1000,
    ordered: true,
    maxSubscribers: 1000,
    maxEventSize: 1024 * 1024
  }
];
```

Register channels alongside events at bootstrap (step 5 above) —
`channelService.registerChannels(channelConfigs)`.

## Inversify Configuration

```typescript
// src/inversify.config.ts
import { PubSubService, EventService, ChannelService, InMemoryAdapter, TYPES } from '@saga-ed/soa-pubsub-server';
import type { PubSubAdapter } from '@saga-ed/soa-pubsub-server';

export const container = new Container();

// Order matters — bind the adapter before the services that depend on it
container.bind<PubSubAdapter>(TYPES.PubSubAdapter).to(InMemoryAdapter).inSingletonScope();
container.bind(TYPES.EventService).to(EventService).inSingletonScope();
container.bind(TYPES.ChannelService).to(ChannelService).inSingletonScope();
container.bind('PubSubService').to(PubSubService).inSingletonScope();
```

`InMemoryAdapter` is the only `PubSubAdapter` implementation shipped today — there is
no Redis (or other distributed) adapter yet, despite what an older draft of this guide
claimed. Implement `PubSubAdapter` (`packages/node/pubsub-server/src/adapters/base-adapter.ts`)
if you need one.

## Testing Your Implementation

Use a **static `appRouter` import** with `@trpc/server/adapters/express`'s
`createExpressMiddleware` — not dynamic `ControllerLoader` loading. See
[`.claude/rules/testing-node.md`](../.claude/rules/testing-node.md)'s "Controller
Loading in Tests" section for why: dynamic `await import()` breaks under Vitest's
TypeScript decorator/parameter-property transpilation.

```typescript
// src/sectors/pubsub/trpc/__tests__/pubsub-integration.int.test.ts
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from '../../../app-router.js';
import type { TRPCContext } from '../../../trpc.js';
import { events } from '../events.js';
import { container } from '../../../inversify.config.js';
import { PubSubService, TYPES, ChannelService } from '@saga-ed/soa-pubsub-server';
import type { ILogger } from '@saga-ed/soa-logger';
import type { EventDefinition, ChannelConfig } from '@saga-ed/soa-pubsub-core';
import express from 'express';

describe('PubSub Integration', () => {
  let app: express.Application;
  let server: ReturnType<express.Application['listen']>;

  beforeAll(async () => {
    app = express();
    const logger = container.get<ILogger>('ILogger');
    const pubsubService = container.get<PubSubService>('PubSubService');
    const channelService = container.get<ChannelService>(TYPES.ChannelService);

    pubsubService.registerEvents(events as unknown as Record<string, EventDefinition>);
    channelService.registerChannels([
      { name: 'pingpong', family: 'demo', ordered: false, maxSubscribers: 100,
        maxEventSize: 1024 * 1024, historyRetentionMs: 24 * 60 * 60 * 1000, authScope: 'user' } satisfies ChannelConfig
    ]);

    app.use('/saga-soa/v1/trpc', createExpressMiddleware({
      router: appRouter,
      createContext: (): TRPCContext => ({ logger, pubsubService, channelService }),
    }));
    server = app.listen(0);
  });

  afterAll(() => server.close());

  it('sends a ping and gets a pong result', async () => {
    const response = await request(app)
      .post('/saga-soa/v1/trpc/pubsub.ping')
      .send({ message: 'hello', timestamp: new Date().toISOString() })
      .expect(200);

    expect(response.body.result.data.success).toBe(true);
  });
});
```

## Troubleshooting

**"Unknown channel: `<name>`" errors** — the pubsub service validates channel
membership before processing an event. Register the channel (step 5) before any
event on it is sent; a channel and its events must be registered together at
bootstrap, not lazily.

**Events not registering** — check that `main.ts` calls `pubsubService.registerEvents(events)`
and `channelService.registerChannels([...])` before the server starts listening, and
that both calls target the same container-resolved singletons the tRPC context uses.

**Type errors on `action`** — `CSEEvent['action']` is `AbsAction<TResult>` — an object
with `requestId` and `act(payload, context?)`, not a plain function. `SSEEvent` has no
`action` property at all.

**Dependency injection errors** — bind in this order: adapter, then `EventService` and
`ChannelService` (both depend on it), then `PubSubService` (depends on all three).

## Next Steps

1. Write unit tests for your event definitions and `act()` implementations.
2. Write an integration test using the static-router pattern above.
3. Add authentication/authorization to your events via `authScope`.
4. If you need delivery beyond a single process, implement a `PubSubAdapter` — there
   is no distributed adapter to reach for yet.
