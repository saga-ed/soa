# Vitest Testing Conventions

## Overview
All saga-derived monorepos use Vitest for unit and integration testing. This document covers testing patterns, conventions, and best practices.

## Configuration

### Basic Setup
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

### Workspace Configuration
For monorepos, use workspace config:
```typescript
// vitest.workspace.ts
export default [
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
];
```

## Test Structure

### AAA Pattern with Comments
Always structure tests using Arrange-Act-Assert with explicit comments:

```typescript
describe('UserService', () => {
  describe('createUser', () => {
    it('should create a user with valid input', async () => {
      // Arrange
      const userInput = UserFactory.build();
      const repository = new MockUserRepository();
      const service = new UserService(repository);

      // Act
      const result = await service.createUser(userInput);

      // Assert
      expect(result.id).toBeDefined();
      expect(result.email).toBe(userInput.email);
    });
  });
});
```

### File Naming
- Unit tests: `*.test.ts` (colocated with source)
- Integration tests: `*.integration.test.ts`
- E2E tests: `*.e2e.test.ts`

```
src/
├── services/
│   ├── user.service.ts
│   └── user.service.test.ts      # Unit tests
├── __tests__/
│   └── user.integration.test.ts  # Integration tests
```

## Factory Pattern with Fishery

### Defining Factories
Use fishery for test data generation:

```typescript
// factories/user.factory.ts
import { Factory } from 'fishery';
import { User } from '../types.js';

export const UserFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,
  email: `user${sequence}@example.com`,
  name: `Test User ${sequence}`,
  createdAt: new Date(),
  status: 'active',
}));
```

### Using Factories
```typescript
// Generate single instance
const user = UserFactory.build();

// Generate with overrides
const adminUser = UserFactory.build({ role: 'admin' });

// Generate multiple
const users = UserFactory.buildList(5);

// Generate with transient params
const UserFactory = Factory.define<User>(({ transientParams }) => ({
  email: transientParams.domain
    ? `user@${transientParams.domain}`
    : 'user@example.com',
}));

const user = UserFactory.build({}, { transient: { domain: 'test.com' } });
```

### Factory Traits
Define reusable configurations:

```typescript
export const UserFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,
  email: `user${sequence}@example.com`,
  status: 'active',
}))
  .trait('inactive', { status: 'inactive' })
  .trait('admin', { role: 'admin', permissions: ['all'] });

// Usage
const inactiveUser = UserFactory.build({ traits: ['inactive'] });
const adminUser = UserFactory.build({ traits: ['admin'] });
```

## Mocking Patterns

### Simple Mocks with vi.fn()
```typescript
const mockSave = vi.fn().mockResolvedValue({ id: '123' });
const repository = { save: mockSave };

// Verify calls
expect(mockSave).toHaveBeenCalledWith(expectedData);
expect(mockSave).toHaveBeenCalledTimes(1);
```

### Mocking Modules
```typescript
vi.mock('./database.js', () => ({
  connect: vi.fn().mockResolvedValue(mockConnection),
  disconnect: vi.fn(),
}));
```

### Mocking Classes
```typescript
const MockUserRepository = vi.fn(() => ({
  findById: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));

// In test
const mockRepo = new MockUserRepository();
mockRepo.findById.mockResolvedValue(UserFactory.build());
```

### Spying on Methods
```typescript
const service = new UserService(repository);
const spy = vi.spyOn(service, 'validateUser');

await service.createUser(input);

expect(spy).toHaveBeenCalledWith(input);
```

## Async Testing

### Testing Promises
```typescript
it('should resolve with user data', async () => {
  // Arrange
  const expected = UserFactory.build();
  mockRepo.findById.mockResolvedValue(expected);

  // Act
  const result = await service.getUser('123');

  // Assert
  expect(result).toEqual(expected);
});
```

### Testing Rejections
```typescript
it('should throw on invalid input', async () => {
  // Arrange
  const invalidInput = { email: 'not-an-email' };

  // Act & Assert
  await expect(service.createUser(invalidInput))
    .rejects
    .toThrow(ValidationError);
});
```

### Testing with Timers
```typescript
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('should retry after delay', async () => {
  // Arrange
  mockApi.call.mockRejectedValueOnce(new Error()).mockResolvedValueOnce('success');

  // Act
  const promise = service.callWithRetry();
  await vi.advanceTimersByTimeAsync(1000);
  const result = await promise;

  // Assert
  expect(result).toBe('success');
});
```

## Integration Testing

### Database Integration
```typescript
describe('UserRepository Integration', () => {
  let db: Database;
  let repository: UserRepository;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.clear();
    repository = new UserRepository(db);
  });

  it('should persist and retrieve user', async () => {
    // Arrange
    const user = UserFactory.build();

    // Act
    await repository.save(user);
    const retrieved = await repository.findById(user.id);

    // Assert
    expect(retrieved).toEqual(user);
  });
});
```

### API Integration
```typescript
describe('User API Integration', () => {
  let app: Express;
  let request: SuperTest;

  beforeAll(async () => {
    app = await createTestApp();
    request = supertest(app);
  });

  it('should create user via POST', async () => {
    // Arrange
    const input = { email: 'test@example.com', name: 'Test' };

    // Act
    const response = await request
      .post('/api/users')
      .send(input)
      .expect(201);

    // Assert
    expect(response.body.email).toBe(input.email);
  });
});
```

## Test Isolation

### Container Reset
When using Inversify, reset container between tests:

```typescript
describe('UserService', () => {
  let container: Container;

  beforeEach(() => {
    container = createTestContainer();
  });

  it('should work in isolation', () => {
    const service = container.get<UserService>(TOKENS.UserService);
    // Test with fresh container
  });
});
```

### Cleaning Up Side Effects
```typescript
afterEach(async () => {
  vi.clearAllMocks();
  await cleanupTestData();
});
```

## Coverage Requirements

### Minimum Thresholds
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
```

### Running Coverage
```bash
pnpm test --coverage
pnpm test --coverage --reporter=html
```

## Anti-Patterns

### Avoid
- Tests without AAA comments
- Shared mutable state between tests
- Testing implementation details instead of behavior
- Ignoring async/await (fire-and-forget)
- Hard-coded test data (use factories)
- Testing private methods directly

### Prefer
- One assertion concept per test
- Descriptive test names that explain behavior
- Factory-generated test data
- Testing public API and behavior
- Isolated tests that can run in any order

## Related Memories
- `inversify_patterns.md` - Testing with dependency injection
- `typescript_conventions.md` - Async patterns and error handling
