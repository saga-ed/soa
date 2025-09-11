# TRPCServer

The `TRPCServer` class provides a centralized, injectable way to manage tRPC routers in the saga-soa framework. It solves the problem of multiple `initTRPC` calls by providing a single tRPC instance that can be shared across all sector routers.

## Key Features

- **Single tRPC Instance**: Eliminates multiple `initTRPC` calls across your application
- **Dynamic Router Composition**: Add routers at runtime using `mergeRouters`
- **Dependency Injection**: Fully integrated with Inversify DI container
- **Express Integration**: Built-in Express middleware creation
- **Type Safety**: Full TypeScript inference maintained
- **Logging**: Integrated logging for router operations

## Basic Usage

### 1. Configuration

```typescript
import { TRPCServerSchema } from '@hipponot/api-core/trpc-server-schema';

const trpcConfig = TRPCServerSchema.parse({
  configType: 'TRPC_SERVER',
  name: 'My tRPC API',
  basePath: '/api/trpc', // optional, defaults to '/trpc'
  contextFactory: async () => ({ user: 'current-user' }), // optional
});
```

### 2. DI Container Setup

```typescript
import { Container } from 'inversify';
import { TRPCServer } from '@hipponot/api-core/trpc-server';

const container = new Container();

// Bind configuration
container.bind('TRPCServerConfig').toConstantValue(trpcConfig);
container.bind('ILogger').to(PinoLogger); // or MockLogger for tests
container.bind(TRPCServer).toSelf();
```

### 3. Creating Sector Routers

```typescript
// Get the TRPCServer instance
const trpcServer = container.get(TRPCServer);

// Create sector routers using the shared tRPC instance
const userRouter = trpcServer.router({
  getAll: trpcServer.procedures.query(() => {
    return getAllUsers();
  }),

  getById: trpcServer.procedures.input(z.object({ id: z.string() })).query(({ input }) => {
    return getUserById(input.id);
  }),

  create: trpcServer.procedures
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
      })
    )
    .mutation(({ input }) => {
      return createUser(input);
    }),
});

const projectRouter = trpcServer.router({
  getAll: trpcServer.procedures.query(() => {
    return getAllProjects();
  }),

  // ... more procedures
});
```

### 4. Adding Routers

```typescript
// Add individual routers
trpcServer.addRouter('user', userRouter);
trpcServer.addRouter('project', projectRouter);

// Or add multiple routers at once
trpcServer.addRouters({
  user: userRouter,
  project: projectRouter,
});
```

### 5. Express Integration

```typescript
import { ExpressServer } from '@hipponot/api-core/express-server';

// Initialize Express server
const expressServer = container.get(ExpressServer);
await expressServer.init(container, []);
const app = expressServer.getApp();

// Create and mount tRPC middleware
const trpcMiddleware = trpcAppRouter.createExpressMiddleware();
app.use(trpcAppRouter.getBasePath(), trpcMiddleware);

// Start the server
expressServer.start();
```

## API Reference

### Constructor

```typescript
constructor(
  @inject('TRPCAppRouterConfig') config: TRPCAppRouterConfig,
  @inject('ILogger') logger: ILogger
)
```

### Methods

#### `getTRPC()`

Returns the shared tRPC instance for creating procedures and middleware.

#### `get procedures`

Returns the shared procedures from the tRPC instance.

#### `get router`

Returns the shared router builder from the tRPC instance.

#### `addRouter(name: string, router: AnyRouter): void`

Adds a single router with a name. If a router with the same name already exists, it will be overwritten.

#### `addRouters(routers: Record<string, AnyRouter>): void`

Adds multiple routers at once.

#### `getRouter(): AnyRouter`

Returns the final merged router with all added routers. Uses tRPC's `mergeRouters` internally.

#### `createExpressMiddleware()`

Creates Express middleware for the merged router with proper error handling.

#### `getBasePath(): string`

Returns the configured base path for the tRPC API.

#### `getName(): string`

Returns the name of this tRPC app.

#### `getRouterNames(): string[]`

Returns all registered router names.

#### `hasRouter(name: string): boolean`

Checks if a router with the given name exists.

#### `removeRouter(name: string): boolean`

Removes a router by name. Returns `true` if the router was found and removed.

#### `clearRouters(): void`

Clears all registered routers.

## Benefits Over Previous Pattern

### Before (Multiple initTRPC calls)

```typescript
// ❌ Multiple tRPC instances
const t1 = initTRPC.create();
const t2 = initTRPC.create();
const t3 = initTRPC.create();

export const projectRouter = t1.router({ ... });
export const runRouter = t2.router({ ... });
export const appRouter = t3.router({
  project: projectRouter,
  run: runRouter,
});
```

### After (Single tRPC instance)

```typescript
// ✅ Single tRPC instance shared across all routers
const trpcAppRouter = container.get(TRPCAppRouter);

const projectRouter = trpcAppRouter.router({ ... });
const runRouter = trpcAppRouter.router({ ... });

trpcAppRouter.addRouters({
  project: projectRouter,
  run: runRouter,
});

const appRouter = trpcAppRouter.getRouter();
```

## Testing

The `TRPCAppRouter` is fully testable using the `MockLogger`:

```typescript
import { MockLogger } from '@hipponot/logger/mocks';

container.bind('ILogger').to(MockLogger);
const trpcAppRouter = container.get(TRPCAppRouter);

// Test router operations
const testRouter = trpcAppRouter.router({
  hello: trpcAppRouter.procedures.query(() => 'world'),
});

trpcAppRouter.addRouter('test', testRouter);
expect(trpcAppRouter.hasRouter('test')).toBe(true);
```

## Migration Guide

To migrate from the old pattern to `TRPCAppRouter`:

1. **Remove individual `initTRPC` calls** from sector router files
2. **Import shared procedures** from `TRPCAppRouter` instance
3. **Use `addRouter`/`addRouters`** instead of manual router composition
4. **Use `getRouter()`** to get the final merged router
5. **Update Express middleware creation** to use `createExpressMiddleware()`

This approach provides better maintainability, type safety, and follows the same patterns as other saga-soa components like `ExpressServer`.
