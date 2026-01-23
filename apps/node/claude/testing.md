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
