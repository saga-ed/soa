# Node.js Backend Testing

Testing patterns specific to Node.js backend applications.

For shared patterns, see [claude/testing/](../../../claude/testing/).

## DI/Inversify Testing

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

## Database Testing

**Requirement**: Docker containers (matches CI environment).

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:15
  redis:
    image: redis:7
```

## Database Isolation (Parallel Tests)

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

## Integration Test Pattern

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

## Controller Loading in Tests

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

## ESM Patterns in Tests

For ESM-specific patterns (like `__dirname` workaround for file path resolution), see [claude/esm.md](../../../claude/esm.md).

**Common test use case**: Schema pattern resolution

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Works from any CWD
const schemaPatterns = [path.resolve(__dirname, '../../schemas/**/*.gql')];
```

See [claude/esm.md](../../../claude/esm.md) for complete ESM documentation.
