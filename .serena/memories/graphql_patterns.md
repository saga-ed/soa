# GraphQL SDL-First Patterns

## Overview
saga-soa uses SDL-first GraphQL with @apollo/server. Schemas are defined in `.gql` files.

## Schema Definition

### File Organization
```
src/
├── schemas/
│   ├── content.gql       # Content domain schema
│   └── user.gql          # User domain schema
└── sectors/
    └── content/
        └── gql/
            └── content.resolver.ts
```

### Base Schema
First sector defines base types:

```graphql
# schemas/content.gql
type Content {
  id: ID!
  title: String!
  createdAt: String!
}

type Query {
  contents: [Content!]!
  content(id: ID!): Content
}

type Mutation {
  createContent(title: String!): Content!
}
```

### Extending Types
Subsequent sectors extend:

```graphql
# schemas/user.gql
type User {
  id: ID!
  email: String!
}

extend type Query {
  users: [User!]!
  user(id: ID!): User
}
```

## Resolver Pattern

### Base Controller
Resolvers extend `AbstractGQLController`:

```typescript
import { injectable, inject } from 'inversify';
import { AbstractGQLController, ResolverMap } from '@saga-ed/soa-api-core';
import { ILogger } from '@saga-ed/soa-logger';

@injectable()
export class ContentResolver extends AbstractGQLController {
  readonly sectorName = 'content';

  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('IContentRepository') private readonly repo: IContentRepository
  ) {
    super(logger);
  }

  getResolvers(): ResolverMap {
    return {
      Query: {
        contents: () => this.repo.findAll(),
        content: (_, { id }) => this.repo.findById(id),
      },
      Mutation: {
        createContent: (_, args) => this.repo.create(args),
      },
    };
  }
}
```

### Resolver Arguments
```typescript
getResolvers(): ResolverMap {
  return {
    Query: {
      // No args
      contents: () => this.getContents(),

      // With args
      content: (_parent, args: { id: string }) => this.getContent(args.id),

      // With context
      me: (_parent, _args, ctx: GQLContext) => this.getUser(ctx.userId),
    },
  };
}
```

### Field Resolvers
```typescript
getResolvers(): ResolverMap {
  return {
    Query: { /* ... */ },

    Content: {
      author: (parent: Content) => this.userRepo.findById(parent.authorId),
    },
  };
}
```

## Error Handling

### GraphQL Errors
```typescript
import { GraphQLError } from 'graphql';

async getById(id: string): Promise<Content> {
  const content = await this.repo.findById(id);
  if (!content) {
    throw new GraphQLError('Content not found', {
      extensions: { code: 'NOT_FOUND', id },
    });
  }
  return content;
}
```

### Error Codes
- `NOT_FOUND` - Resource doesn't exist
- `VALIDATION_ERROR` - Invalid input
- `UNAUTHORIZED` - Not authenticated
- `FORBIDDEN` - Not authorized

## Context Pattern

```typescript
interface GQLContext {
  userId?: string;
  db: Db;
  logger: ILogger;
}

app.use('/graphql', expressMiddleware(server, {
  context: async ({ req }): Promise<GQLContext> => ({
    userId: getUserIdFromRequest(req),
    db: container.get<Db>('Db'),
    logger: container.get<ILogger>('ILogger'),
  }),
}));
```

## DataLoaders for N+1

```typescript
import DataLoader from 'dataloader';

function createUserLoader(db: Db) {
  return new DataLoader<string, User | null>(async (ids) => {
    const users = await db.collection<User>('users')
      .find({ _id: { $in: ids.map(id => new ObjectId(id)) } })
      .toArray();
    const map = new Map(users.map(u => [u._id.toString(), u]));
    return ids.map(id => map.get(id) ?? null);
  });
}
```

## Anti-Patterns

### Avoid
- Business logic in resolvers
- HTTP status codes for errors
- N+1 queries without DataLoaders

### Prefer
- Thin resolvers delegating to services
- GraphQL errors with codes
- DataLoaders for batching

## Related Memories
- `mongodb_patterns.md` - Database queries
- `inversify_patterns.md` - DI for resolvers
