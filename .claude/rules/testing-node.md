---
paths:
  - "apps/node/**"
  - "packages/node/**"
---

# Node.js Testing — apps and packages

> Path-scoped rule. Loads when Claude touches a Node.js backend app
> (`apps/node/**`) or a shared Node.js package (`packages/node/**`). Shared
> cross-runtime conventions (naming, ARES purposes, builders) live in
> [`docs/testing/`](../../docs/testing/README.md), not here.

## Backend apps (`apps/node/**`)

### DI/Inversify Testing

Create a test container with mock bindings:

```typescript
import { Container } from 'inversify';

describe('MyService', () => {
  let container: Container;
  let service: MyService;
  let mockLogger: ILogger;

  beforeEach(() => {
    container = new Container();

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind('Config').toConstantValue({ timeout: 1000 });
    container.bind(MyService).toSelf();

    service = container.get(MyService);
  });

  it('logs on initialization', () => {
    expect(mockLogger.info).toHaveBeenCalled();
  });
});
```

### Database Testing

**Requirement**: Docker containers (matches CI environment).

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:15
  redis:
    image: redis:7
```

### Database Isolation (Parallel Tests)

All integration tests must run in parallel without interference.

**Strategy**: Per-worker database naming:

```typescript
const dbName = `test_${process.env.VITEST_POOL_ID || 'default'}`;
```

**Vitest config**:

```typescript
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
```

**TestDatabase interface** (shared infrastructure):

```typescript
interface TestDatabase {
  getConnection(): Promise<DatabaseConnection>;
  cleanup(): Promise<void>;
  seed(scenario: TestScenario): Promise<void>;
}
```

### Integration Test Pattern

```typescript
describe('API Integration', () => {
  let app: Express;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  it('returns 401 for unauthenticated requests', async () => {
    const response = await request(app)
      .get('/api/sessions')
      .expect(401);
  });
});
```

### Controller Loading in Tests

**Rule**: Use static imports for controllers in test files. Do NOT use dynamic loading with ControllerLoader.

**Why**:
- Vitest transpiles TypeScript at compile time for static imports
- Dynamic imports (`await import()`) fail with TypeScript decorators and parameter properties
- Prevents module identity mismatches between SOURCE and DIST code
- Explicit dependencies are clearer in test code

**Pattern**:

```typescript
// ✅ GOOD: Static imports
import { UserResolver } from '../sectors/user/gql/user.resolver.js';
import { AuthResolver } from '../sectors/auth/gql/auth.resolver.js';

const gqlResolvers = [UserResolver, AuthResolver];
const gqlServer = container.get<GQLServer>(GQLServer);
await gqlServer.init(container, gqlResolvers);
```

```typescript
// ❌ BAD: Dynamic loading (causes module identity issues in tests)
const controllerLoader = container.get(ControllerLoader);
const gqlResolvers = await controllerLoader.loadControllers(
  path.resolve(__dirname, '../sectors/*/gql/*.resolver.ts'),
  AbstractGQLController
);
```

**Note**: Production code (main.ts) can still use dynamic loading. This constraint applies only to test files.

### ESM Patterns in Tests

For ESM-specific patterns (like `__dirname` workaround for file path resolution), see [docs/esm.md](../../docs/esm.md).

**Common test use case**: Schema pattern resolution

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Works from any CWD
const schemaPatterns = [path.resolve(__dirname, '../../schemas/**/*.gql')];
```

See [docs/esm.md](../../docs/esm.md) for complete ESM documentation.

## Node packages (`packages/node/**`)

Packages are consumed by multiple apps. Tests should verify:

- **Public API contracts** (acceptance tests)
- **Edge cases in utilities** (regression tests)
- **Package can be imported** (smoke tests)

### Unit Test Pattern

Test public exports, mock external dependencies:

```typescript
// packages/node/api-core/src/__tests__/validation.unit.test.ts
import { validateEmail } from '../validation.js';

describe('validateEmail', () => {
  it('accepts valid email addresses', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(validateEmail('not-an-email')).toBe(false);
  });
});
```

### Testing Exported Types

Ensure type exports work as documented:

```typescript
// Type test - compilation is the test
import type { UserConfig } from '@saga-ed/soa-api-core';

const config: UserConfig = {
  timeout: 1000,
  retries: 3,
};
```

### Smoke Test Pattern

Verify package imports correctly:

```typescript
// packages/node/api-core/src/__tests__/import.smoke.test.ts
describe('Package Smoke Tests', () => {
  it('exports main entry point', async () => {
    const module = await import('@saga-ed/soa-api-core');
    expect(module).toBeDefined();
  });
});
```

### Package-Specific Builders

Each package maintains its own builders in `__tests__/builders/`:

```
packages/node/api-core/
  src/
    __tests__/
      builders/
        request.builder.ts
        response.builder.ts
        index.ts
```

### Vitest Config

Each package has its own `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

Referenced from: root `CLAUDE.md`'s rules index, `apps/node/CLAUDE.md`,
`packages/node/CLAUDE.md`, and every leaf CLAUDE.md whose directory matches
`paths:` above.
