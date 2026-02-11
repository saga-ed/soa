# db

MongoDB connection management and database utilities.

## Responsibilities

- MongoDB client lifecycle management (connect/disconnect)
- Connection string building with authentication
- Inversify DI integration for database clients
- Mock MongoDB provider for testing (mongodb-memory-server)
- Zod-validated database configuration
- Future: MySQL and Redis connection managers (stubs present)

## Parent Context

See [/packages/node/CLAUDE.md](../CLAUDE.md) for Node.js package patterns.

## Tech Stack

- **Database**: MongoDB (native driver)
- **DI**: Inversify
- **Validation**: Zod
- **Testing**: mongodb-memory-server
- **Build**: tsup → ESM

## Structure

```
src/
├── index.ts                      # Main exports
├── mongo-provider.ts             # MongoDB connection manager
├── mongo-provider-config.ts      # Zod config schema
├── i-mongo-conn-mgr.ts          # Connection manager interface
├── mocks/
│   └── mock-mongo-provider.ts   # In-memory MongoDB for tests
├── redis.ts                      # Placeholder for Redis
└── sql.ts                        # Placeholder for MySQL
```

## Key Exports

```typescript
// MongoDB provider
import { MongoProvider, MongoProviderSchema } from '@saga-ed/soa-db';
import type { MongoProviderConfig, IMongoConnMgr } from '@saga-ed/soa-db';

// DI symbols
import { MONGO_CLIENT, MONGO_CLIENT_FACTORY } from '@saga-ed/soa-db';

// Testing mocks
import { MockMongoProvider } from '@saga-ed/soa-db/mocks/mock-mongo-provider';
```

## Usage Pattern

```typescript
// In inversify.config.ts
import { MongoProvider, MONGO_CLIENT } from '@saga-ed/soa-db';

const mongoConfig = {
  host: 'localhost',
  port: 27017,
  database: 'mydb',
  instanceName: 'main',
  options: {}
};

const provider = new MongoProvider(mongoConfig);
await provider.connect();

container.bind(MONGO_CLIENT).toConstantValue(provider.getClient());

// In services
const client = container.get<MongoClient>(MONGO_CLIENT);
const db = client.db('mydb');
const collection = db.collection('users');
```

## Key Features

**Connection Management:**
- Automatic connection string building with authentication
- Connection state tracking (isConnected)
- Graceful connect/disconnect
- MongoClient instance caching

**DI Integration:**
- Inversify-compatible provider pattern
- Symbol-based bindings for type safety
- Factory pattern for multi-instance support

**Testing Support:**
- MockMongoProvider uses mongodb-memory-server
- Isolated in-memory MongoDB for parallel tests
- No external MongoDB dependency in test environment

## Convention Deviations

None - follows all SOA patterns.

## See Also

- `/packages/node/api-core/` - API server utilities
- `/apps/node/CLAUDE.md` - Backend app patterns
- `/apps/node/claude/testing.md` - Database testing patterns

---

*Last updated: 2026-02*
