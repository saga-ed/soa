# Canonical tRPC Client Pattern

This document explains the canonical way to access tRPC APIs in the Saga SOA platform and why the standalone `trpc-client` module was removed.

## Architecture Overview

The Saga SOA platform demonstrates a clean separation of concerns for tRPC client usage:

### 1. Type Safety Layer (`@hipponot/trpc-types`)
- **Pure type definitions** with no server dependencies
- Generated from Zod schemas in the server implementation
- Provides full TypeScript support for all API operations
- Can be used by any client without server dependencies

### 2. Client Implementation Layer
- **web-client**: Demonstrates the canonical pattern using `@trpc/client`
- **Direct HTTP**: Alternative approach using standard HTTP requests
- Both approaches use types from `@hipponot/trpc-types`

### 3. Server Implementation Layer (`trpc-api`)
- Actual tRPC server implementation
- Contains Zod schemas that generate the types
- Completely separate from client usage

## Canonical Pattern

The **web-client** demonstrates the canonical way to access tRPC APIs:

```typescript
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@hipponot/trpc-types';

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: 'http://localhost:5000/saga-soa/v1/trpc',
    }),
  ],
});

// Type-safe API calls
const projects = await client.project.getAllProjects.query();
const newProject = await client.project.createProject.mutate({
  name: 'My Project',
  description: 'A new project',
  status: 'active'
});
```

## Why the trpc-client Module Was Removed

The standalone `trpc-client` module was redundant because:

1. **web-client already demonstrates the pattern**: It shows exactly how to use `@trpc/client` with `@hipponot/trpc-types`
2. **Unnecessary abstraction**: The trpc-client was just a thin wrapper around the same pattern
3. **Maintenance overhead**: Having two ways to do the same thing creates confusion
4. **Type safety already achieved**: Through `@hipponot/trpc-types` which has no server dependencies

## Benefits of the Current Architecture

### ✅ Type Safety
- Full TypeScript support through `@hipponot/trpc-types`
- Compile-time validation of API calls
- IntelliSense support for all operations

### ✅ No Server Dependencies
- Client code only depends on types, not server implementation
- Can be used in any environment without server code
- Clear separation of concerns

### ✅ Flexibility
- Can use `@trpc/client` for optimal performance
- Can use standard HTTP requests for debugging
- Can use any HTTP client library

### ✅ Maintainability
- Single source of truth for types
- Clear canonical pattern
- Easy to understand and extend

## Demo Page Features

The `/trpc-api` demo page provides:

1. **tRPC Client Mode**: Uses the canonical `@trpc/client` approach
2. **cURL Mode**: Uses HTTP requests with curl commands
3. **Interactive Testing**: Test API calls directly in the browser
4. **Code Generation**: See the exact code needed for each operation
5. **Type Safety**: All operations are type-safe through `@hipponot/trpc-types`

## Migration Guide

If you were using the old `trpc-client` module:

### Before (removed)
```typescript
import { TRPCClient } from '@hipponot/trpc-client';

const client = new TRPCClient();
const result = await client.createProject(data);
```

### After (canonical pattern)
```typescript
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@hipponot/trpc-types';

const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: 'http://localhost:5000/saga-soa/v1/trpc' })],
});

const result = await client.project.createProject.mutate(data);
```

## Conclusion

The web-client now serves as the **canonical example** for tRPC client usage in the Saga SOA platform. It demonstrates:

- How to use `@trpc/client` with type safety
- How to separate types from server implementation
- How to provide both tRPC and HTTP access patterns
- How to maintain clean architecture with proper dependencies

This approach is simpler, more maintainable, and provides a single clear pattern for all tRPC client usage. 