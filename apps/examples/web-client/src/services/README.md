# Web Client Services

This directory contains services that demonstrate how to interact with the Saga SOA APIs using different approaches.

## Services Overview

### 1. TrpcClientService
**Canonical tRPC Client Pattern**

This service demonstrates the **canonical way** to access tRPC APIs using the `@trpc/client` library with type safety provided by `@hipponot/trpc-types`.

#### Key Features:
- **Type Safety**: Full TypeScript support using `@hipponot/trpc-types`
- **No Server Dependencies**: Only depends on types, not the actual server implementation
- **Real tRPC Client**: Uses `@trpc/client` with `httpBatchLink` for optimal performance
- **Error Handling**: Proper error handling and response formatting

#### Usage Pattern:
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

### 2. TrpcCurlService
**HTTP-based tRPC Access**

This service demonstrates how to access tRPC APIs using standard HTTP requests and curl commands.

#### Key Features:
- **HTTP-based**: Uses standard HTTP requests instead of tRPC client
- **cURL Examples**: Generates curl commands for manual testing
- **No Dependencies**: Pure HTTP implementation without tRPC client library
- **Debugging**: Useful for debugging and understanding the HTTP layer

#### Usage Pattern:
```typescript
// Direct HTTP calls
const response = await fetch('http://localhost:5000/saga-soa/v1/trpc/project.getAllProjects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({})
});
```

## Type Safety Architecture

The web-client demonstrates the proper separation of concerns:

1. **`@hipponot/trpc-types`**: Pure type definitions (no server dependencies)
2. **`@trpc/client`**: Standard tRPC client library
3. **Server Implementation**: Separate package with actual API implementation

This architecture ensures:
- ✅ **Type Safety**: Full TypeScript support
- ✅ **No Server Dependencies**: Client code doesn't depend on server implementation
- ✅ **Flexibility**: Can use any tRPC client or HTTP client
- ✅ **Maintainability**: Clear separation of concerns

## API Endpoints

The demo supports the following endpoints:

### Project Endpoints
- `project.getAllProjects` - Get all projects
- `project.getProjectById` - Get project by ID
- `project.createProject` - Create new project
- `project.updateProject` - Update existing project
- `project.deleteProject` - Delete project

### Run Endpoints
- `run.getAllRuns` - Get all runs
- `run.getRunById` - Get run by ID
- `run.createRun` - Create new run
- `run.updateRun` - Update existing run
- `run.deleteRun` - Delete run

## Demo Page

The `/trpc-api` page provides an interactive demonstration of both approaches:
- **tRPC Client Mode**: Uses the canonical `@trpc/client` approach
- **cURL Mode**: Uses HTTP requests with curl commands

This demonstrates how the same API can be accessed using different methods while maintaining type safety through `@hipponot/trpc-types`. 