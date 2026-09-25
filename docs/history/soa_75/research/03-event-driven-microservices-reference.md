# Event-Driven Microservices in TypeScript — Reference Guide

> Covers: core concepts, broker comparisons, off-the-shelf options, greenfield best practices, and bootstrapping new services against existing data.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [TypeScript Off-the-Shelf Options](#typescript-off-the-shelf-options)
3. [RabbitMQ vs. Alternatives](#rabbitmq-vs-alternatives)
4. [Greenfield Best Practices (Small Team)](#greenfield-best-practices-small-team)
5. [Bootstrapping a New Service Against Existing Data](#bootstrapping-a-new-service-against-existing-data)

---

## Core Concepts

### The Problem These Patterns Solve

Traditional systems store **current state**:

```
orders: { id: 123, status: "shipped", total: 49.99 }
```

You know what the order is, but not how it got there. Was it discounted? Cancelled and reinstated? The history is gone.

---

### Event Sourcing

Instead of storing current state, store every thing that happened as an immutable sequence of events:

```
event 1: OrderPlaced     { id: 123, total: 59.99 }
event 2: DiscountApplied { id: 123, amount: 10.00 }
event 3: PaymentReceived { id: 123 }
event 4: OrderShipped    { id: 123 }
```

Current state is **derived** by replaying those events. The event log is the source of truth.

**Benefits:**
- Full audit history for free
- Reconstruct state at any point in time
- Add new projections retroactively from the same history

---

### Projections

A projection is a **read model built by consuming events**. You listen to the event stream and maintain a derived view optimised for querying.

```
Event stream →  [Projection A] → "orders by customer" table
             →  [Projection B] → "revenue by day" table
             →  [Projection C] → search index
```

Each projection is independent. If you need a new view, create a new projection and replay history to build it.

---

### CQRS (Command Query Responsibility Segregation)

Separates **writes** from **reads**:

```
Write side:  Command → validate → emit event → event store
Read side:   Event → update projection → query-optimised read model
```

You don't query the event store directly — you query projections. Reads and writes can be scaled and optimised independently.

---

### Event-Driven Architecture (EDA)

Services communicate by **publishing and subscribing to events** rather than calling each other directly:

```
OrderService --[OrderShipped]-→ RabbitMQ --→ NotificationService
                                         --→ InventoryService
                                         --→ AnalyticsService
```

Services are decoupled — `OrderService` doesn't know or care who's listening.

---

### How the Concepts Relate

```
EDA            = services talk via events (loose coupling)
Event Sourcing = store events as source of truth (not current state)
CQRS           = separate write model from read models
Projections    = read models built by consuming events
```

You can use any combination:
- EDA without event sourcing — most common starting point
- Event sourcing without EDA — single service, internal only
- All three together — full "CQRS + ES" pattern

---

## TypeScript Off-the-Shelf Options

### Event Store / Event Sourcing Focused

**EventStoreDB** (`@eventstore/db-client`)
- Purpose-built event store with native projection support (JS-based projection DSL)
- Strong consistency, competing consumers, catch-up subscriptions
- Best fit if event sourcing is central to your design

**Axon Server** (via HTTP/gRPC)
- Java-native but accessible from TS via REST/gRPC
- Mature CQRS + event sourcing; overkill unless you're all-in on DDD

---

### Message Broker / Event Bus Focused

**NestJS + CQRS module** (`@nestjs/cqrs`)
- First-class CQRS/event sourcing support in the NestJS ecosystem
- Pairs well with any broker (RabbitMQ, Kafka, Redis Streams)
- Projection handling is DIY

**BullMQ** (Redis-backed)
- Reliable queues with job patterns; not a true event log
- Good for lightweight event-driven flows
- Excellent TypeScript support

**Kafka** (`kafkajs` or `confluent-kafka`)
- Log-based, replayable, natural fit for projections via consumer groups
- `kafkajs` has excellent TS support
- High operational overhead; industry standard for scale

---

### Higher-Level / AWS-Native

**AWS EventBridge + DynamoDB Streams + Lambda**
- Serverless-native, zero ops overhead
- Good if you're already deep in AWS

**NestJS + Postgres Outbox Pattern** (DIY but very common)
- Projections as read models updated via domain events
- Most pragmatic path for small teams

---

### Recommendation by Context

| Situation | Recommendation |
|---|---|
| Full event sourcing + projections | EventStoreDB |
| NestJS shop, moderate complexity | NestJS CQRS + Kafka/RabbitMQ |
| AWS-heavy, serverless | EventBridge + DynamoDB Streams + Lambda |
| Simple, fast to ship | BullMQ or RabbitMQ + outbox pattern |
| High throughput, replayable streams | Kafka + kafkajs |

---

## RabbitMQ vs. Alternatives

### The Core Trade-off

RabbitMQ is a **message broker** — smart routing, dumb storage. Kafka and EventStoreDB are **event logs** — dumb routing, smart storage. This distinction drives almost every comparison.

---

### RabbitMQ vs. Kafka

| Dimension | RabbitMQ | Kafka |
|---|---|---|
| Model | Push-based, messages deleted after ACK | Pull-based, append-only log |
| Replay | ❌ Not natively | ✅ Core feature |
| Projections | Awkward — need separate read stores | Natural — consumer groups at any offset |
| Throughput | ~50k msg/s per node | Millions/s |
| Ordering | Per-queue | Per-partition |
| Routing | Very flexible (exchanges, bindings) | Basic (topics + partitions) |
| Operational complexity | Moderate | High |
| Latency | Very low (~ms) | Low but higher than RabbitMQ |

**Verdict:** Kafka wins if you need replay and projections as first-class citizens. RabbitMQ wins for flexible routing and task queues.

---

### RabbitMQ vs. Redis Streams (BullMQ)

| Dimension | RabbitMQ | Redis Streams |
|---|---|---|
| Persistence | Durable, designed for it | Yes, but Redis is primarily memory |
| Replay | ❌ | ✅ (consumer groups + offset) |
| Complexity | Moderate | Low |
| At-scale reliability | High | Moderate (memory pressure) |

**Verdict:** Redis Streams is great for lightweight flows in smaller systems. Not a replacement at scale.

---

### RabbitMQ vs. EventStoreDB

| Dimension | RabbitMQ | EventStoreDB |
|---|---|---|
| Purpose | General messaging | Purpose-built event sourcing |
| Projections | ❌ DIY | ✅ Native (JS-based DSL) |
| Event replay | ❌ | ✅ Core feature |
| Subscriptions | Consumers/queues | Catch-up, persistent, volatile |
| Adoption | Ubiquitous | Niche but growing |

**Verdict:** EventStoreDB is the right tool if event sourcing is your primary pattern, not just a messaging layer.

---

### RabbitMQ vs. AWS EventBridge / SNS+SQS

| Dimension | RabbitMQ | EventBridge / SNS+SQS |
|---|---|---|
| Ops overhead | Self-managed | Zero (fully managed) |
| Routing | Flexible exchange model | EventBridge rules are powerful |
| Replay | ❌ | Limited (S3 archive) |
| Vendor lock-in | Low | High |
| Cost model | Instance-based | Per-event |
| Local dev | Easy (Docker) | Awkward (LocalStack) |

---

### Summary

```
Replay / Projections needed?    → Kafka or EventStoreDB
Flexible routing, task queues?  → RabbitMQ
Serverless / AWS-native?        → EventBridge + SQS
Lightweight / low ops?          → Redis Streams
```

---

## Greenfield Best Practices (Small Team)

### Overarching Principle: Start Simple, Design for Evolution

Adopt complexity only when you feel the pain that justifies it. Full CQRS + ES is powerful but carries real cost for a small team.

---

### Recommended Starting Point: EDA-Lite

Event-driven communication between services, with each service internally simple (just a DB, no event sourcing yet).

```
Service A         RabbitMQ          Service B
─────────         ────────          ─────────
Write to DB  →  Publish event  →  React, update own DB
(source of       (notification)    (own read model)
 truth)
```

Each service owns its data. Events are notifications, not the source of truth.

---

### Best Practices

**1. One database per service**

Never share a database between services.

```
✅  OrderService → orders_db
    UserService  → users_db

❌  OrderService ↘
                  shared_db
    UserService ↗
```

**2. Use the Transactional Outbox Pattern**

Guarantees events are never lost if publishing fails after a DB write:

```sql
BEGIN TRANSACTION
  INSERT INTO orders (...)
  INSERT INTO outbox (event: 'OrderPlaced', payload: {...})
COMMIT
-- Separate process polls outbox, publishes to RabbitMQ, deletes on confirm
```

**3. Design events as facts, not commands**

```
✅  OrderPlaced, PaymentFailed, UserRegistered   (things that happened)
❌  CreateOrder, ProcessPayment                  (things to do)
```

Commands go to one recipient and can be rejected. Events are broadcast facts.

**4. Version your events from day one**

```typescript
type OrderPlacedV1 = {
  version: 1;
  orderId: string;
  total: number;
};

type OrderPlacedV2 = {
  version: 2;
  orderId: string;
  total: number;
  currency: string; // added later
};
```

Consumers should handle unknown fields gracefully.

**5. Each service projects its own read models**

Don't let services query each other's databases. Maintain a local copy built from events:

```
OrderService emits OrderPlaced
     ↓
ShippingService consumes it → writes to its own shipping_orders table
     ↓
ShippingService queries its own DB — never calls OrderService directly
```

**6. Embrace and document eventual consistency**

Data will be slightly stale between services. Document which parts of the system are eventually consistent so the team doesn't build against an assumption of immediate consistency.

---

### What to Defer Until You Need It

| Pattern | Defer until... |
|---|---|
| Full event sourcing | You need audit history or time-travel queries |
| Kafka | You outgrow RabbitMQ throughput or need replay badly |
| Saga orchestration | You have complex multi-service transactions |
| CQRS per service | A service has genuinely divergent read/write needs |
| Schema registry | Event schemas are changing frequently |

---

### Suggested Stack

```
Framework:      NestJS (built-in CQRS module, good structure for small teams)
Broker:         RabbitMQ
Outbox:         Postgres + polling worker (or Debezium for CDC)
Read models:    Postgres or DynamoDB per service
Typing:         Shared npm package for event schemas
Observability:  OpenTelemetry from day one
```

---

### The Most Important Thing

**Define service boundaries carefully before writing code.** Wrong boundaries cause more pain than any technology choice.

> Services should align with **business capabilities** (Ordering, Payments, Notifications) — not technical layers (API, Database, Cache).

---

## Bootstrapping a New Service Against Existing Data

### The Problem

A new service (e.g. OrderService) depends on data from an existing service (e.g. UserService) that has been running for a year with no events published. You need a local read model of users, but there's nothing to replay.

---

### Strategy 1: Bootstrap Sync + Events (Most Common)

One-time data migration to seed the new service's read model, then switch to event-driven updates going forward.

```
Phase 1 — Seed:
  UserService exposes a read API (or internal DB read)
  → OrderService pulls all users, writes to its own users table
  → Record the sync timestamp

Phase 2 — Switch to events:
  UserService starts publishing UserCreated, UserUpdated events
  → OrderService consumes them to stay in sync
```

**Critical:** Start consuming events *before* the seed completes to avoid a gap window:

```
Timeline:
──────────────────────────────────────────────►
     [start consuming events]
          [run bulk seed]
                    [seed complete — you're live]
```

Duplicates during the overlap window are handled by idempotent upserts.

---

### Strategy 2: Retroactive Event Publishing

UserService emits synthetic historical events for all existing users:

```typescript
// One-time migration job in UserService
for (const user of await db.users.findAll()) {
  await broker.publish('UserCreated', {
    userId: user.id,
    email: user.email,
    createdAt: user.createdAt, // original date
  });
}
```

OrderService treats these exactly like real events. After backfill, normal event flow continues.

**Pros:** OrderService needs no special bootstrap logic — pure event consumption.

**Cons:** Large burst of synthetic events; consumers need idempotency and rate-limit tolerance.

---

### Strategy 3: On-Demand Hydration (Lazy)

No pre-seeding. When OrderService needs a user it doesn't have locally, fetch it synchronously and cache it:

```typescript
async getUser(userId: string) {
  const local = await this.usersRepo.findById(userId);
  if (local) return local;

  // Fallback: fetch from UserService, store locally
  const user = await this.userServiceClient.getUser(userId);
  await this.usersRepo.upsert(user);
  return user;
}
```

**Pros:** Zero upfront migration work.

**Cons:** Creates a runtime dependency on UserService. Avoid on critical paths.

---

### Strategy 4: CDC via Debezium

If UserService can't be modified to publish events, stream changes from its database transaction log:

```
UserService Postgres → Debezium → Kafka/RabbitMQ → OrderService
```

Debezium can do the initial snapshot (full table read) then switch to streaming — solving the bootstrap problem automatically.

**Pros:** No changes to UserService required.

**Cons:** More infrastructure. Couples you to UserService's internal DB schema.

---

### Choosing a Strategy

```
Can you modify UserService?
  ├── Yes, data volume is manageable  → Retroactive event publishing
  ├── Yes, but data is large          → Bootstrap sync + events
  └── No                             → CDC (Debezium) or on-demand hydration

Is this a critical path?
  ├── Yes  → Avoid on-demand hydration
  └── No   → On-demand hydration is fine short-term
```

---

### Universal Recommendations (Regardless of Strategy)

**Make consumers idempotent:**

```typescript
await db.users.upsert(
  { userId: event.userId },
  { onConflict: 'userId', update: ['email', 'name', 'updatedAt'] }
);
```

**Project only what you need.** OrderService's local user record should contain only the fields OrderService actually uses (e.g. `userId`, `email`, `shippingAddress`) — not a full copy of UserService's model.

**Version synthetic events** the same as real ones.

**Document the dependency** in the service README: what the read model is a projection of, and what the expected lag is.
