# MongoDB Patterns

## Overview
saga-soa uses MongoDB with the native driver (5.7.0). The `@saga-ed/soa-db` package provides connection management and utilities.

## Connection Management

### Using soa-db Package
```typescript
import { createDbProvider, IDbProvider } from '@saga-ed/soa-db';

// Create provider
const dbProvider = await createDbProvider(process.env.MONGO_URI);

// Register in container
container.bind<IDbProvider>('IDbProvider').toConstantValue(dbProvider);
container.bind<Db>('Db').toConstantValue(dbProvider.db);
```

### Repository Pattern
```typescript
import { injectable, inject } from 'inversify';
import { Db, ObjectId } from 'mongodb';

@injectable()
export class UserRepository implements IUserRepository {
  constructor(@inject('Db') private readonly db: Db) {}

  async findById(id: string): Promise<User | null> {
    return this.db.collection<User>('users')
      .findOne({ _id: new ObjectId(id) });
  }
}
```

## Collection Access

### Typed Collections
Always use generics for type safety:

```typescript
interface User {
  _id: ObjectId;
  email: string;
  name: string;
  createdAt: Date;
}

const users = db.collection<User>('users');
const user = await users.findOne({ email: 'test@example.com' });
```

### Collection Naming
- Plural, lowercase: `users`, `contents`, `sessions`
- Compound names: `user_activities`, `content_items`

## Query Patterns

### Find Operations
```typescript
// Find one
const user = await collection.findOne({ _id: new ObjectId(id) });

// Find many with options
const users = await collection
  .find({ status: 'active' })
  .sort({ createdAt: -1 })
  .limit(10)
  .toArray();

// With projection
const emails = await collection
  .find({}, { projection: { email: 1, name: 1 } })
  .toArray();
```

### Insert Operations
```typescript
// Insert one
const result = await collection.insertOne({
  email: input.email,
  name: input.name,
  createdAt: new Date(),
});

// Insert many
const result = await collection.insertMany(documents);
```

### Update Operations
```typescript
// Update one
await collection.updateOne(
  { _id: new ObjectId(id) },
  { $set: { name: newName, updatedAt: new Date() } }
);

// Upsert
await collection.updateOne(
  { email: user.email },
  { $set: user },
  { upsert: true }
);
```

### Delete Operations
```typescript
await collection.deleteOne({ _id: new ObjectId(id) });
await collection.deleteMany({ status: 'deleted' });
```

## ObjectId Handling

### Converting Strings
```typescript
import { ObjectId } from 'mongodb';

// In repository
async findById(id: string): Promise<User | null> {
  if (!ObjectId.isValid(id)) return null;
  return this.collection.findOne({ _id: new ObjectId(id) });
}
```

### Validation Helper
```typescript
function isValidObjectId(id: string): boolean {
  return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
}
```

## Index Management

### Creating Indexes
```typescript
async function ensureIndexes(db: Db): Promise<void> {
  const users = db.collection('users');

  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ status: 1, createdAt: -1 });
  await users.createIndex({ name: 'text', email: 'text' });
}
```

## Aggregation

```typescript
const results = await collection.aggregate([
  { $match: { status: 'active' } },
  { $group: {
    _id: '$department',
    count: { $sum: 1 }
  }},
  { $sort: { count: -1 } }
]).toArray();
```

## Error Handling

### Duplicate Key
```typescript
import { MongoServerError } from 'mongodb';

try {
  await collection.insertOne(doc);
} catch (error) {
  if (error instanceof MongoServerError && error.code === 11000) {
    throw new Error('Document already exists');
  }
  throw error;
}
```

## Anti-Patterns

### Avoid
- Using Mongoose or other ODMs
- String IDs without ObjectId conversion
- Missing projections on large documents
- N+1 queries

### Prefer
- Native MongoDB driver
- Typed collections with generics
- Batch operations
- Proper indexes

## Related Memories
- `project_overview.md` - Database stack overview
- `inversify_patterns.md` - Repository injection
