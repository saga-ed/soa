# Inversify Dependency Injection Patterns

## Overview
All saga-derived monorepos use Inversify for dependency injection. This enables loose coupling, testability, and clean architecture.

## Core Concepts

### Injectable Classes
Every service, repository, and controller must be decorated with `@injectable()`:

```typescript
import { injectable } from 'inversify';

@injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly logger: Logger
  ) {}
}
```

### Injection Tokens
Use symbols as injection tokens to avoid string-based injection:

```typescript
// tokens.ts
export const TOKENS = {
  UserRepository: Symbol.for('UserRepository'),
  UserService: Symbol.for('UserService'),
  Logger: Symbol.for('Logger'),
  Database: Symbol.for('Database'),
} as const;
```

### Container Registration
Register all dependencies in a central container file:

```typescript
// container.ts
import { Container } from 'inversify';
import { TOKENS } from './tokens.js';

export function createContainer(): Container {
  const container = new Container();

  // Singletons - one instance shared
  container.bind(TOKENS.Logger).to(ConsoleLogger).inSingletonScope();
  container.bind(TOKENS.Database).to(MongoDatabase).inSingletonScope();

  // Transient - new instance each time
  container.bind(TOKENS.UserRepository).to(UserRepository).inTransientScope();
  container.bind(TOKENS.UserService).to(UserService).inTransientScope();

  return container;
}
```

## Injection Patterns

### Constructor Injection (Preferred)
Always use constructor injection for required dependencies:

```typescript
@injectable()
export class UserService {
  constructor(
    @inject(TOKENS.UserRepository) private readonly userRepository: UserRepository,
    @inject(TOKENS.Logger) private readonly logger: Logger
  ) {}
}
```

### Property Injection (Avoid)
Avoid property injection - it makes dependencies less visible:

```typescript
// Avoid this pattern
@injectable()
export class UserService {
  @inject(TOKENS.Logger)
  private logger!: Logger;
}
```

### Optional Dependencies
Use `@optional()` for dependencies that may not be registered:

```typescript
@injectable()
export class UserService {
  constructor(
    @inject(TOKENS.UserRepository) private readonly userRepository: UserRepository,
    @inject(TOKENS.Analytics) @optional() private readonly analytics?: Analytics
  ) {}
}
```

## Scope Patterns

### Singleton Scope
Use for stateless services, connections, and shared resources:

```typescript
// Database connections
container.bind(TOKENS.Database).to(MongoDatabase).inSingletonScope();

// Loggers
container.bind(TOKENS.Logger).to(ConsoleLogger).inSingletonScope();

// Configuration
container.bind(TOKENS.Config).toConstantValue(config);
```

### Transient Scope
Use for stateful services or when each consumer needs a fresh instance:

```typescript
// Services with request-specific state
container.bind(TOKENS.RequestContext).to(RequestContext).inTransientScope();

// Factories
container.bind(TOKENS.UserService).to(UserService).inTransientScope();
```

### Request Scope
Use for per-request instances (requires middleware setup):

```typescript
container.bind(TOKENS.RequestContext).to(RequestContext).inRequestScope();
```

## Factory Patterns

### Simple Factory
For creating instances with runtime parameters:

```typescript
// Define factory type
type UserServiceFactory = (tenantId: string) => UserService;

// Register factory
container.bind<UserServiceFactory>(TOKENS.UserServiceFactory).toFactory((context) => {
  return (tenantId: string) => {
    const repo = context.container.get<UserRepository>(TOKENS.UserRepository);
    return new UserService(repo, tenantId);
  };
});

// Use factory
const factory = container.get<UserServiceFactory>(TOKENS.UserServiceFactory);
const service = factory('tenant-123');
```

### Auto Factory
For simple cases, use `toAutoFactory`:

```typescript
container.bind(TOKENS.UserServiceFactory).toAutoFactory(TOKENS.UserService);
```

## Testing with Inversify

### Rebinding for Tests
Override dependencies in tests:

```typescript
describe('UserService', () => {
  let container: Container;
  let mockRepository: MockUserRepository;

  beforeEach(() => {
    container = createContainer();
    mockRepository = new MockUserRepository();

    // Override with mock
    container.rebind(TOKENS.UserRepository).toConstantValue(mockRepository);
  });

  it('should create user', async () => {
    const service = container.get<UserService>(TOKENS.UserService);
    // Test with mocked dependency
  });
});
```

### Creating Test Containers
Create minimal containers for unit tests:

```typescript
function createTestContainer(): Container {
  const container = new Container();

  // Only bind what's needed for the test
  container.bind(TOKENS.UserRepository).toConstantValue(mockRepository);
  container.bind(TOKENS.Logger).toConstantValue(mockLogger);
  container.bind(TOKENS.UserService).to(UserService);

  return container;
}
```

## Common Patterns

### Module Pattern
Organize bindings by domain:

```typescript
// user.module.ts
export function registerUserModule(container: Container): void {
  container.bind(TOKENS.UserRepository).to(UserRepository);
  container.bind(TOKENS.UserService).to(UserService);
  container.bind(TOKENS.UserController).to(UserController);
}

// container.ts
export function createContainer(): Container {
  const container = new Container();

  registerCoreModule(container);
  registerUserModule(container);
  registerOrderModule(container);

  return container;
}
```

### Interface Binding
Bind to interfaces for flexibility:

```typescript
// Bind interface to implementation
container.bind<IUserRepository>(TOKENS.UserRepository).to(MongoUserRepository);

// Easy to swap implementations
container.rebind<IUserRepository>(TOKENS.UserRepository).to(PostgresUserRepository);
```

## Anti-Patterns

### Service Locator
Avoid passing the container around:

```typescript
// Bad - service locator anti-pattern
@injectable()
class UserService {
  constructor(@inject(Container) private container: Container) {}

  getUser() {
    const repo = this.container.get(TOKENS.UserRepository); // Avoid!
  }
}

// Good - explicit dependencies
@injectable()
class UserService {
  constructor(@inject(TOKENS.UserRepository) private repo: UserRepository) {}
}
```

### Circular Dependencies
Inversify will throw on circular dependencies. Resolve by:
1. Extracting shared logic to a new service
2. Using lazy injection with `@lazyInject`
3. Restructuring the dependency graph

## Related Memories
- `typescript_conventions.md` - Decorator and class patterns
- `vitest_testing.md` - Testing with dependency injection
