# tRPC Pub/Sub Infrastructure Specification

A complete technical specification for a tRPC-based pub/sub infrastructure that supports:

- **CSE** — Client-Sent Events (client → server actions)
- **SSE** — Server-Sent Events (server → client pushes)
- Strong typing for event names & payloads
- Multiple logical channels (families of related events)
- Reusable libraries:
  - `trpc-pubsub-server` — server runtime, tRPC procedures, SSE handler, adapters, action execution
  - `trpc-pubsub-client` — typed client helpers for SSE + tRPC subscriptions and sending CSEs
  - `events/<api>-events` — API-specific compiled module that exports types for client and full event definitions (including action code) for server

---

## 1. Goals & assumptions

**Goals**
- Single source of truth for events and payload types.
- Typed client experience: clients compile against generated types.
- Support for both server-push (SSE / tRPC subscription) and client-initiated events (CSE) that execute server-side actions.
- Channels group logically-related events and can have per-channel policies (auth, retention, ordering).
- Pluggable adapters (Redis, Kafka, NATS, in-memory) for publish/subscribe and optional persistence.

**Assumptions**
- TypeScript codebase, tRPC v10 style.
- `zod` (or another runtime schema lib) is available for runtime validation.
- Production deployments will prefer durable message systems (Kafka / Redis Streams / managed PubSub) for scaling.
- SSE endpoint used for browsers and simpler clients; tRPC subscriptions via websockets used as fallback or for richer transport.

---

## 2. Concepts & core data models

### 2.1 Event envelope
```ts
type EventName = `${string}:${string}`; // Example: "orders:created"

interface EventEnvelope<Name extends EventName = EventName, Payload = unknown> {
  id: string;                 // unique id (uuid/v4)
  name: Name;                 // canonical event name
  channel: string;            // logical family, e.g. "orders"
  payload: Payload;
  timestamp: string;          // ISO 8601
  meta?: Record<string, any>; // optional metadata (source, version, partitionKey, clientEventId)
}
```

### 2.2 Event Definition (compile-time)
```ts
interface EventDefinition<Payload, Result = void> {
  name: string;                       // canonical event name "orders:created"
  channel: string;                    // logical family
  payloadSchema?: ZodSchema<Payload>; // optional runtime schema for validation
  direction?: "SSE" | "CSE" | "BOTH";
  action?: (ctx: ActionCtx, payload: Payload, opts?: ActionOpts) => Promise<Result>; // server-side action for CSE
  description?: string;
  version?: number;
}
```

### 2.3 Channel config
```ts
interface ChannelConfig {
  name: string;
  family?: string; // optional grouping of channels
  authScope?: string | ((ctx: ServerCtx) => boolean | Promise<boolean>);
  historyRetentionMs?: number; // history TTL for late subscribers
  ordered?: boolean; // whether ordering is guaranteed
}
```

### 2.4 Server-side Action context
```ts
interface ActionCtx {
  user?: { id: string; roles: string[] };
  requestId?: string;
  services: {
    db: DbClient;
    cache?: CacheClient;
    logger: Logger;
    idempotency?: IdempotencyStore;
    // ... other app services
  };
  emit: (event: EventEnvelope) => Promise<void>; // emit additional events
}
```

---

## 3. Library responsibilities & API

### 3.1 `events/<api>-events` (API-specific events library)
**Responsibilities**
- Authoritative event definitions (payload schemas + optional server action code).
- Export a *client* build (types only, no server-side action code) and a *server* build (full definitions + actions).
- Provide codegen outputs: `client-types.d.ts` and `server-manifest.js`.

**Exports (example)**
```ts
export const events = {
  "orders:created": { /* EventDefinition */ },
  "orders:updated": { /* ... */ },
};

export type EventNames = keyof typeof events;
export type EventPayload<T extends EventNames> = typeof events[T] extends EventDefinition<infer P, any> ? P : never;
```

**Build pattern**
- `npm run build:client` → strips `action` functions, outputs types for browser clients.
- `npm run build:server` → includes `action` logic for server runtime.

---

### 3.2 `trpc-pubsub-server`
**Purpose**
- Create tRPC procedures for:
  - CSE: `mutation sendEvent({ name, payload, clientEventId? })`
  - Subscriptions: `subscription subscribe({ channel, filters? })`
  - Optional: `query fetchHistory({ channel, since?, limit? })`
- Provide SSE HTTP handler: `/events?channel=...` returning `text/event-stream`.
- Validate payloads, perform authorization, execute `action` functions, and publish events via adapter.

**Public API**
```ts
type PubSubServerOptions = {
  router: TRPCRouter; // base app router
  events: Record<string, EventDefinition>;
  channels?: ChannelConfig[];
  adapter: PubSubAdapter;
  auth?: (ctx: ServerCtx) => Promise<User | null>;
  subscriptionPath?: string;
  ssePath?: string;
};

function createPubSubServer(opts: PubSubServerOptions): {
  router: TRPCRouter;       // augmented with sendEvent, subscribe, fetchHistory
  createSSEHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  shutdown: () => Promise<void>;
};
```

**tRPC Procedures**
- `mutation sendEvent(input: { name: string; payload: any; clientEventId?: string }): { status, result?, emittedEvents?: EventEnvelope[] }`
  - Steps:
    1. Authenticate sender
    2. Validate payload schema
    3. If event has `action`, run the action in `ActionCtx`
    4. Persist/publish events (using adapter)
    5. Return result or error
- `subscription subscribe({ channel, filters? })` returns Observable<EventEnvelope>
- `query fetchHistory({ channel, since?, limit? })` optional when adapter supports retention

**Adapter interface (pluggable)**
```ts
interface PubSubAdapter {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(channel: string, handler: (event: EventEnvelope) => Promise<void>): Promise<{ unsubscribe: () => Promise<void> }>;
  persist?(event: EventEnvelope): Promise<void>; // optional history
  fetchHistory?(channel: string, opts: { since?: string, limit?: number }): Promise<EventEnvelope[]>;
  health?(): Promise<{ healthy: boolean; details?: any }>;
  shutdown?(): Promise<void>;
}
```

**Action execution guarantees**
- Server must execute `action` either synchronously or inside a managed transaction depending on adapter capabilities.
- Provide idempotency helpers for actions to avoid duplicate side-effects (using `clientEventId`).
- If `action` `emit`s events via `ctx.emit`, those events go through the same publish path.

---

### 3.3 `trpc-pubsub-client`
**Purpose**
- Typed client utilities for:
  - Opening SSE connections
  - Creating tRPC subscriptions
  - Sending typed CSEs (mapped to `sendEvent` mutation)
- Token provider integration (Authorization header) and reconnect strategies.

**Public API sketch**
```ts
type PubSubClientOptions = {
  url: string;           // tRPC base url
  sseUrl?: string;       // SSE endpoint base
  tokenProvider?: () => Promise<string | null>;
  reconnectStrategy?: { minDelayMs?: number; maxDelayMs?: number; factor?: number };
  onError?: (err) => void;
};

function createPubSubClient<TEvents>(opts: PubSubClientOptions) {
  return {
    sendEvent<Name extends keyof TEvents>(name: Name, payload: TEvents[Name], opts?: { clientEventId?: string }): Promise<any>,
    subscribe<Name extends keyof TEvents>(channel: string, onEvent: (evt: EventEnvelope<Name, TEvents[Name]>) => void, opts?: SubscribeOptions): Unsubscribe,
    openSSE(channel: string, onEvent: (evt: EventEnvelope) => void, opts?: SSEOptions): SSEController,
    createTRPCSubscribe(channel: string, filters?: Record<string, any>): TRPCSubscriptionHandle
  }
}
```

**Client behavior**
- `sendEvent` maps to tRPC `sendEvent` mutation.
- `openSSE` uses `EventSource` where possible; if token auth required, client should use `fetch` + `ReadableStream` polyfill or use query-param token (careful with URL leak).
- Automatic fallbacks: if SSE not available, prefer tRPC subscription for server pushes.
- Type-safety enforced by generated `events-client` types.

---

## 4. Protocol & transport details

### 4.1 SSE format
HTTP response headers:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```
Each event:
```
id: <event-id>
event: <event-name>
data: <JSON-serialized EventEnvelope>
```
Example:
```
id: 123e4567-e89b-12d3-a456-426614174000
event: orders:created
data: {"id":"123e4567-e89b-12d3-a456-426614174000","name":"orders:created","channel":"orders","payload":{...},"timestamp":"..."}
```

### 4.2 tRPC subscriptions
- Use the `observable` pattern in tRPC to push `EventEnvelope` instances to each subscriber.
- Subscription input should include `channel`, optional `filters`, and an optional `cursor` for resuming (if history supported).

### 4.3 CSE (Client Sent Event) flow
1. Client constructs payload (optionally includes `clientEventId`).
2. Calls tRPC mutation `sendEvent({ name, payload, clientEventId })`.
3. Server authenticates & authorizes the client for that channel/event.
4. Server validates payload against `payloadSchema` if present.
5. If event has `action`, server executes it in `ActionCtx`.
6. `action` may `emit` further events which are published.
7. Server returns `status` and any action result.

### 4.4 Ordering & partitions
- When `channel.ordered` is true, adapter should provide ordering (single partition or defined partition key).
- For high throughput, support partitioning by `partitionKey` in `meta`.
- When ordering is required across many clients, consider partitioning by tenant/user and guarantee ordering per partition.

---

## 5. Reliability, retries, idempotency

### 5.1 Delivery guarantees
- Default: **at-least-once** for publish (duplicates possible).
- If **exactly-once** required for side-effects, implement idempotency at action side (idempotency store) or use adapter transactional semantics.

### 5.2 Idempotency utilities
- Provide `idempotencyStore` service in `ActionCtx.services`:
```ts
await ctx.services.idempotency.runIfNotProcessed(clientEventId, async () => {
  // side-effect once
});
```
- Accept `clientEventId` as optional input from client for deduping.

### 5.3 Retry semantics
- SSE clients implement reconnect + backoff (server may return recommended `retry`).
- tRPC subscriptions reconnect handled with websocket client settings.
- For `sendEvent` mutation, client may retry on transient HTTP/5xx. Server should support idempotency.

---

## 6. Security & authorization

### Authentication
- Support Bearer tokens in Authorization header, cookies, or query param with caution for SSE.
- For SSE where browsers use `EventSource` and cannot set headers, recommend:
  - short-lived query token and HTTPS, or
  - use a proxy that injects `Authorization`.

### Authorization
- Per-channel `authScope` or callback. Example:
```ts
if (!channel.authScope || checkScope(user, channel.authScope)) { ... }
```
- On `sendEvent`, check publish rights. On `subscribe`, check read rights.

### Input validation
- Use runtime schemas (zod) to validate payloads before action execution.

### Rate limiting & quotas
- Middleware for per-user/per-channel rate limits to prevent abuse.

### Audit logging
- Log CSE events, who sent them, action results, and errors for compliance.

### Secrets
- Do **not** ship secrets to client builds of `events` lib. Only server build contains action code that can reference secrets.

---

## 7. Versioning & evolution

- Include `version` in `EventDefinition` and `meta`.
- For incompatible schema changes, create a new event name (e.g., `orders:created.v2`) or bump `version`.
- Provide adapter/consumer helpers for translating old → new payloads if necessary.

---

## 8. Packaging & distribution

- `events/<api>-events` package exports two entrypoints:
  - `./client` — types only (no server actions)
  - `./server` — full definitions with actions
- `trpc-pubsub-client` and `trpc-pubsub-server` published as separate npm packages with peerDependencies on `@trpc/client`/`@trpc/server`.

---

## 9. Operational & scaling concerns

### Adapter choices
- Dev: in-memory adapter.
- Lite: Redis Pub/Sub or Redis Streams (fast, common).
- Durable: Kafka / NATS / managed cloud pubsub for high durability and ordering.

### Scaling model
- Stateless servers connect to adapter; events routed through adapter.
- SSE connections: each server holds connections — use sticky sessions or front proxy (e.g., for many clients use specialized connection managers).
- WebSockets for tRPC subscriptions may require sticky sessions or external store for subscriptions.

### Persistence
- Optional persistence layer for history (Redis Streams, Kafka, DB), configurable per-channel with TTL.

### Backpressure & slow consumers
- Per-connection buffer limits; if a client falls behind, expose drop/skip policy or terminate connection.

### Monitoring
- Track metrics:
  - publish throughput
  - subscribe count per channel
  - action latency, error rates
  - SSE connection durations
- Instrument traces (attach requestId to event lifecycle).

---

## 10. Observability & testing

### Tracing & logs
- Trace: `receive CSE → validation → actionStart → persist → publish → delivered` with `requestId`.
- Ensure structured logs include event name, id, channel, client id, and outcome.

### Tests
- Unit tests for each action with mock `ActionCtx.services`.
- Integration test using in-memory adapter:
  - Client sends CSE
  - Action runs
  - Subscribers receive expected SSE/tRPC message
- Load tests simulate many SSE connections and many producers.

---

## 11. Example code sketches

### 11.1 Event definition (source)
```ts
// events/orders.ts
import { z } from "zod";
import type { EventDefinition } from "trpc-pubsub-server";

export const orders_created: EventDefinition<{ orderId: string; total: number }, { ok: boolean }> = {
  name: "orders:created",
  channel: "orders",
  payloadSchema: z.object({ orderId: z.string(), total: z.number() }),
  description: "Published when an order is created",
  action: async (ctx, payload) => {
    // idempotency check
    if (payload.orderId) {
      const already = await ctx.services.idempotency?.check(payload.orderId);
      if (already) return { ok: false };
    }

    await ctx.services.db.insert('orders', payload);
    await ctx.emit({
      id: crypto.randomUUID(),
      name: "orders:ingested",
      channel: "orders",
      payload,
      timestamp: new Date().toISOString()
    });
    return { ok: true };
  }
};
export const events = { "orders:created": orders_created };
```

### 11.2 Wiring into a tRPC server
```ts
import { initTRPC } from '@trpc/server';
import { createPubSubServer } from 'trpc-pubsub-server';
import { events } from './events/orders';
import { RedisAdapter } from './adapters/redisAdapter';

const t = initTRPC.context<ServerCtx>().create();
const baseRouter = t.router({ /* app procedures */ });

const pubsub = createPubSubServer({
  router: baseRouter,
  events,
  adapter: new RedisAdapter(redisClient),
  auth: async (ctx) => ctx.user
});

export const appRouter = pubsub.router; // use in express/fastify
```

### 11.3 Client usage
```ts
import { createPubSubClient } from 'trpc-pubsub-client';
import type { EventPayload } from 'events-client';

const client = createPubSubClient({ url: '/trpc', sseUrl: '/events', tokenProvider: () => getToken() });

// send a CSE
await client.sendEvent('orders:created', { orderId: 'abc', total: 100 });

// subscribe to orders channel
const unsubscribe = client.subscribe('orders', (evt) => {
  console.log('event', evt.name, evt.payload);
});

// open SSE connection
const sse = client.openSSE('orders', (evt) => { console.log(evt); });
// sse.close();
```

---

## 12. Error handling & failure modes

- **Validation error** → return 400 with structured error.
- **Unauthorized** → 401 / 403.
- **Action failure** → return error to client and consider publishing `events:errors` to an ops channel.
- **Adapter error** → return 503 or queue events depending on adapter.
- **SSE disconnect** → server releases resources; client reconnects with backoff.

---

## 13. Developer ergonomics

- CLI generator: `npx pubsub-gen create-event` → scaffold event with zod schema & action stub.
- Codegen: produce `events-client.d.ts` for client types automatically on build.
- Lint & precommit: ensure each event has `name`, `channel`, and `version` or migration note.

---

## 14. Security checklist (short)
- Use HTTPS for SSE endpoints.
- Avoid query tokens where possible; prefer short-lived tokens if unavoidable.
- Validate all payloads at runtime.
- Limit permissions for actions (principle of least privilege).
- Monitor and alert unusual publish rates.
- Do not include secrets in client builds.

---

## 15. Example event lifecycle (summary)
1. Client A calls `sendEvent("orders:created", payload, clientEventId)`.
2. Server authenticates + validates payload.
3. Server persists event (optional) and runs `action`.
4. `action` may `emit` events.
5. Server publishes events via adapter.
6. Adapter fans out to subscribers (SSE & tRPC) who receive `EventEnvelope`.

---

## 16. Implementation checklist (phased)

**Phase 1 — MVP**
- `events` format + generator
- `trpc-pubsub-server` with in-memory adapter
- tRPC `sendEvent` + `subscribe` procedures
- `trpc-pubsub-client` supporting typed `sendEvent` & subscription
- Basic SSE handler (no auth)

**Phase 2 — Production**
- Redis/Kafka adapters
- SSE with robust auth strategy
- Idempotency store
- Persistence/history per channel
- Metrics & tracing

**Phase 3 — Polish**
- CLI & codegen improvements
- Multi-tenant policies & quotas
- Migration tooling for event schemas

---

## 17. Appendix — Suggested TypeScript types (full)
```ts
// common
export type EventName = string;

export interface EventEnvelope<Name extends EventName = EventName, Payload = any> {
  id: string;
  name: Name;
  channel: string;
  payload: Payload;
  timestamp: string;
  meta?: Record<string, any>;
}

export type ActionResult = any;

export type ActionCtx = {
  user?: { id: string; roles: string[] };
  requestId?: string;
  services: Record<string, any>;
  emit: (e: EventEnvelope) => Promise<void>;
};

export interface EventDefinition<Payload=any, Result=any> {
  name: string;
  channel: string;
  payloadSchema?: { parse: (unknown) => Payload }; // zod-like
  action?: (ctx: ActionCtx, payload: Payload, opts?: { clientEventId?: string }) => Promise<Result>;
  description?: string;
  version?: number;
}

export interface PubSubAdapter {
  publish(event: EventEnvelope): Promise<void>;
  subscribe(channel: string, handler: (e: EventEnvelope) => Promise<void>): Promise<{ unsubscribe: () => Promise<void> }>;
  persist?(event: EventEnvelope): Promise<void>;
  fetchHistory?(channel: string, opts: { since?: string, limit?: number }): Promise<EventEnvelope[]>;
  shutdown?(): Promise<void>;
}
```

---

## Next steps (optional choices I can do for you)
- Generate a runnable minimal repo layout (packages + example server & client).
- Implement a Redis adapter example.
- Produce a codegen script that emits client-only `d.ts` files from server `events` definitions.
- Produce the single-file `.md` for download (I can produce text you can paste).

---

