# Testing Guidance for AI Agents

This guide helps AI coding assistants navigate the testing documentation and understand AI-specific patterns for the Coach, Thrive, and SOA codebases.

## Quick Routing: Which Doc Do You Need?

| Your Task | Read This |
|-----------|-----------|
| Writing or modifying tests | [02-test-conventions.md](./02-test-conventions.md) |
| Understanding test purpose/philosophy | [01-testing-philosophy.md](./01-testing-philosophy.md) |
| Setting up test data | [03-builders-and-scenarios.md](./03-builders-and-scenarios.md) *(Planned)* |
| CI pipeline issues | [04-cicd-integration.md](./04-cicd-integration.md) |
| Quick reference (naming, commands) | See tables at bottom of this doc |

**Decision tree:**

```
What are you doing?
│
├─ Writing new tests?
│   └─ Read: 02-test-conventions.md (structure, patterns)
│
├─ Test is failing after your change?
│   ├─ Is it .spec.test.ts (acceptance)? → Discuss with developer before changing
│   └─ Is it .test.ts (regression)? → Update if new behavior is correct
│
├─ Need test data/fixtures?
│   └─ Read: 03-builders-and-scenarios.md (Planned—currently use inline data)
│
└─ Unsure why tests are organized this way?
    └─ Read: 01-testing-philosophy.md (ARES framework)
```

## DI/Inversify Testing Patterns

These codebases use Inversify for dependency injection. When testing DI-bound services:

### Principle: Inject via Container, Not Hard Imports

Tests should create a test container with mock dependencies, not import services directly with production dependencies.

### Pattern: Test Container Setup

```typescript
import { Container } from 'inversify';
import { MyService } from '../my-service.js';
import type { ILogger } from '@saga-ed/soa-logger';

describe('MyService', () => {
  let container: Container;
  let service: MyService;
  let mockLogger: ILogger;

  beforeEach(() => {
    container = new Container();
    
    // Create mocks
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    // Bind mocks and config
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind('MyServiceConfig').toConstantValue({ timeout: 1000 });
    container.bind(MyService).toSelf();

    // Get service instance
    service = container.get(MyService);
  });

  it('logs on initialization', () => {
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('initialized'));
  });
});
```

### Extract Reusable Test Containers

If you're repeating container setup across tests, extract to a helper:

```typescript
// __tests__/helpers/test-container.ts
export function createTestContainer(overrides?: Partial<TestBindings>) {
  const container = new Container();
  container.bind('ILogger').toConstantValue(overrides?.logger ?? createMockLogger());
  // ... other common bindings
  return container;
}
```

## AI Judgment Calls

### When to Update vs Delete Tests

| Situation | Action |
|-----------|--------|
| Test fails, new behavior is correct | Update the test |
| Test fails, unclear if change is correct | Ask the developer |
| Test is for removed feature | Delete the test |
| Test is flaky and unfixable | Delete (regression) or skip with issue (acceptance) |

### Acceptance vs Regression Decision

- **Acceptance** (`.spec.test.ts`): Behavior stakeholders agreed on. Changing requires discussion.
- **Regression** (`.test.ts`): Implementation detail or edge case. Update freely if correct.

When unsure, default to regression (`.test.ts`). It's easier to promote later than to demote.

### Pragmatic Tradeoffs

See [01-testing-philosophy.md](./01-testing-philosophy.md#pragmatic-tradeoffs) for when to skip or remove tests. Key points:

- Skip non-deterministic edge cases that can't be tested reliably (flag for later)
- Remove tests when coverage is high and refactoring breaks many (flag what's removed)
- Minimum: add regression test for bugs; acceptance tests can follow

## Common AI Mistakes

1. **Over-specifying test data**: Only specify what matters for the test. Use builders with defaults.

2. **Testing implementation details**: Test behavior/contracts, not internal state or method calls.

3. **Silently deleting tests**: Always explain why a test was removed or modified.

4. **Ignoring test naming conventions**: Use `.spec.test.ts` for acceptance, `.int.test.ts` for integration.

5. **Missing DI setup**: Services using Inversify need proper container configuration in tests.

6. **Exact object matching**: Use `toMatchObject` for partial matches, not `toEqual` for large objects.

## Quick Reference

### File Naming (Vitest)

| Purpose | Pattern | Example |
|---------|---------|---------|
| Regression (default) | `*.test.ts` | `user-service.test.ts` |
| Acceptance | `*.spec.test.ts` | `user-creation.spec.test.ts` |
| Integration | `*.int.test.ts` | `api.int.test.ts` |
| Smoke | `*.smoke.test.ts` | `infra.smoke.test.ts` |

### File Naming (Other Tools)

| Tool | Pattern | Example |
|------|---------|---------|
| Storybook | `*.stories.ts` | `Button.stories.ts` |
| Playwright E2E | `*.spec.ts` (in `e2e/`) | `auth.spec.ts` |

### Test Commands

```bash
pnpm test              # Run all tests
pnpm test:unit         # Unit tests only
pnpm test:int          # Integration tests
pnpm test:smoke        # Smoke tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # With coverage report
```

### Workflow Checklist

Before submitting code:
```bash
pnpm test           # All tests pass
pnpm typecheck      # Types are valid
```

When CI fails:
1. Check which suite failed (smoke → unit → integration → e2e)
2. Read the test name and error
3. Determine if your change caused it

## Related Documents

- [00-testing-overview.md](./00-testing-overview.md) - One-page summary, status legend
- [01-testing-philosophy.md](./01-testing-philosophy.md) - ARES framework, pragmatic tradeoffs
- [02-test-conventions.md](./02-test-conventions.md) - Detailed patterns and structure
- [03-builders-and-scenarios.md](./03-builders-and-scenarios.md) - Test data patterns *(Planned)*
- [04-cicd-integration.md](./04-cicd-integration.md) - Pipeline configuration
