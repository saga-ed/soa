# Testing Patterns: Decisions Summary

**Date**: 2026-01-23
**Participants**: Skelly, Nathan (test engineer), Claude
**Status**: Ready for review

---

## Executive Summary

This document captures all testing pattern decisions for the SOA, Thrive, and Coach repositories. Decisions come from two sources:

1. **Nathan's prework** - Comprehensive testing documentation in [sources/testing/](./sources/testing/)
2. **Pair session** - Decisions made during the planning session

These decisions resolve the open questions from the original [plan.md](./plan.md) Phase 6 (Testing Documentation).

---

## Resolved Questions

| # | Topic | Question | Decision | Source |
|---|-------|----------|----------|--------|
| 1 | **Test Framework** | Which test runner to use? | Vitest | Nathan |
| 2 | **Test Philosophy** | How to categorize tests by purpose? | ARES framework (Acceptance, Regression, Exploration, Smoke) | Nathan |
| 3 | **File Naming** | How to distinguish test types in filenames? | `.unit.test.ts` (unit), `.int.test.ts` (integration); add `.spec` or `.smoke` for purpose (e.g., `.unit.spec.test.ts`) | Nathan + Session |
| 4 | **Test Location** | Where should tests live? | `__tests__/` directories adjacent to source code | Nathan |
| 5 | **Builder Library** | Which factory library for test data? | Fishery | Nathan |
| 6 | **BDD/Gherkin** | Should we use Gherkin feature files? | No - structured describe/it blocks are sufficient | Nathan |
| 7 | **Frontend Components** | How to test UI components in isolation? | Vitest browser mode with Svelte plugin | Session |
| 8 | **E2E Testing** | Which tool for end-to-end tests? | Playwright | Nathan |
| 9 | **CI Execution Order** | In what order should test suites run? | Smoke → Unit → Integration/Component → E2E | Nathan |
| 10 | **DI/Inversify Testing** | How to test services with dependency injection? | Create test container with mock bindings | Nathan |
| 11 | **Flaky Test Policy** | What to do with flaky tests? | Remove regression tests; skip acceptance tests with GitHub issue | Nathan |
| 12 | **Database Testing** | In-memory (mongodb-memory-server) vs Docker? | Docker containers (matches CI, "CI is truth") | Session |
| 13 | **DB Isolation** | How to isolate tests for parallel execution? | Per-test/worker isolated databases; shared test infrastructure must support parallel runs | Session |
| 14 | **Spec Traceability** | How should acceptance tests link to specifications? | JSDoc annotations (`@spec TICKET-123`) | Session |
| 15 | **Rollout Priority** | Which repo gets testing patterns first? | SOA first, then thrive/coach | Session |
| 16 | **Test Utils Structure** | Where do domain builders (users, sessions) live? | Per-repo builders; share only utilities via @saga-ed/soa-test-util | Session |
| 17 | **Golden Datasets** | Where should subjective test data live? | Defer until thrive/coach needs arise | Session |
| 18 | **Assertion Style** | Exact match vs partial match for objects? | Prefer `toMatchObject` (partial); only specify what's special | Nathan |
| 19 | **Coverage Target** | What coverage percentage to aim for? | ~80% on critical paths; don't obsess over the number | Nathan |
| 20 | **Test Data Principle** | How much should test data specify? | Only specify what's special; use builder defaults for everything else | Nathan |
| 21 | **Scenarios** | How to share complex test setups? | Scenarios as code - named functions returning test data collections | Nathan |

---

## Key Concepts

### The ARES Framework

Tests are categorized by **type** (how they run) and **purpose** (why we wrote them):

### Test Types (How)

| Type | What It Tests | Tool | File Suffix | Example |
|------|---------------|------|-------------|---------|
| **Unit** | Single module with mocked dependencies | Vitest | `.unit.test.ts` | `user-service.unit.test.ts` |
| **Component** | UI components in browser isolation | Vitest browser mode + Svelte plugin | `.unit.test.ts` | `Button.unit.test.ts` |
| **Integration** | Multiple modules working together | Vitest | `.int.test.ts` | `api.int.test.ts` |
| **E2E** | Full system from UI to database | Playwright | `*.spec.ts` | `auth.spec.ts` |

### Test Purposes (Why) - ARES

| Purpose | What It Answers | Change Review Level | Additional Suffix |
|---------|-----------------|---------------------|-------------------|
| **A**cceptance | Does this meet agreed requirements? | High: Team consensus | `.spec` → `.unit.spec.test.ts` |
| **R**egression | Did we accidentally break something? | Normal: Developer judgment | (none) → `.unit.test.ts` |
| **E**xploration | What happens if I try this? | N/A: Not automated | (manual) |
| **S**moke | Is the test infrastructure working? | Low: Rarely changes | `.smoke` → `.unit.smoke.test.ts` |

### Combining Type and Purpose

File names combine type + optional purpose: `name.[type].[purpose?].test.ts`

| Type + Purpose | File Pattern | Example |
|----------------|--------------|---------|
| Unit + Regression | `*.unit.test.ts` | `user.unit.test.ts` |
| Unit + Acceptance | `*.unit.spec.test.ts` | `user.unit.spec.test.ts` |
| Unit + Smoke | `*.unit.smoke.test.ts` | `setup.unit.smoke.test.ts` |
| Integration + Regression | `*.int.test.ts` | `api.int.test.ts` |
| Integration + Acceptance | `*.int.spec.test.ts` | `api.int.spec.test.ts` |
| Integration + Smoke | `*.int.smoke.test.ts` | `db.int.smoke.test.ts` |

### Core Principles

1. **Only Specify What's Special** - Test data expresses intent, not exact values
2. **Scenarios as Code** - Test setups that survive schema changes
3. **CI is Truth** - Docker-based testing matches CI; CI results are authoritative
4. **Tests Are Documentation** - Acceptance tests are living specifications
5. **JSDoc for Traceability** - `@spec TICKET-123` links tests to requirements
6. **Parallel by Default** - All tests must support parallel execution; DB isolation is a base requirement

---

## File Organization

### Directory Structure

```
packages/
  my-package/
    src/
      services/
        user-service.ts
        __tests__/
          user-service.unit.test.ts        # Unit regression
          user-service.unit.spec.test.ts   # Unit acceptance
          user-service.int.test.ts         # Integration regression
          user-service.int.spec.test.ts    # Integration acceptance
          infra.int.smoke.test.ts          # Integration smoke
          builders/
            user.builder.ts                # Package-specific builders
            index.ts
          fixtures/
            sample-data.json
          helpers/
            test-container.ts              # DI setup helpers
          mocks/
            external-api.ts
```

### File Naming Quick Reference

| Type | Purpose | Pattern | Example |
|------|---------|---------|---------|
| Unit | Regression | `*.unit.test.ts` | `user-service.unit.test.ts` |
| Unit | Acceptance | `*.unit.spec.test.ts` | `user-service.unit.spec.test.ts` |
| Unit | Smoke | `*.unit.smoke.test.ts` | `infra.unit.smoke.test.ts` |
| Integration | Regression | `*.int.test.ts` | `api.int.test.ts` |
| Integration | Acceptance | `*.int.spec.test.ts` | `api.int.spec.test.ts` |
| Integration | Smoke | `*.int.smoke.test.ts` | `db.int.smoke.test.ts` |
| Component | Regression | `*.unit.test.ts` | `Button.unit.test.ts` |
| E2E | - | `*.spec.ts` (in `e2e/`) | `auth.spec.ts` |

**Naming Logic**:
- **Type suffix** (`.unit.`, `.int.`) is always required - describes *how* the test runs
- **Purpose suffix** (`.spec.`, `.smoke.`) is optional - describes *why* we wrote it
- No purpose suffix = regression test (the default)
- Add `.spec.` for acceptance/BDD tests that need team consensus to change
- Add `.smoke.` for infrastructure verification tests

---

## Test Infrastructure

### Shared Utilities (@saga-ed/soa-test-util)

The existing package provides shared utilities only:

- `LocalDateValueFactory` - Fishery factory for dates
- `DateTimeRangeFactory` - Fishery factory for date ranges
- `oneOf(enumObj)` - Random enum selection
- `oneOfArray(array)` - Random array selection

### Per-Repo Domain Builders

Each repository maintains its own domain builders:

```
# SOA
packages/node/api-core/src/__tests__/builders/
  user.builder.ts
  session.builder.ts

# Thrive
packages/processing/src/__tests__/builders/
  transcript.builder.ts
  analysis.builder.ts

# Coach
apps/coach-api/src/__tests__/builders/
  organization.builder.ts
  tutor.builder.ts
```

### Database Testing

- **CI**: Docker containers (PostgreSQL, Redis, MongoDB as needed)
- **Local**: Docker Compose matching CI environment
- **Principle**: "CI is truth" - local should match CI exactly

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:15
  redis:
    image: redis:7
```

### Database Isolation (Parallel Test Requirement)

**Base requirement**: All integration tests must be able to run in parallel without interference.

**Isolation strategies** (shared infrastructure must support):

| Strategy | How It Works | Use Case |
|----------|--------------|----------|
| **Per-worker database** | Each Vitest worker gets unique DB name (e.g., `test_db_worker_1`) | Default for integration tests |
| **Per-test transaction rollback** | Wrap each test in transaction, rollback after | Fast, but limited to single-connection tests |
| **Per-test truncation** | Truncate tables in `beforeEach` | Simple but slower |

**Implementation requirements**:

```typescript
// Shared test infrastructure must provide:
interface TestDatabase {
  // Get isolated database connection for this worker/test
  getConnection(): Promise<DatabaseConnection>;

  // Clean up after test (truncate or rollback)
  cleanup(): Promise<void>;

  // Seed with scenario data
  seed(scenario: TestScenario): Promise<void>;
}
```

**Vitest parallel configuration**:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    pool: 'forks',           // Parallel workers
    poolOptions: {
      forks: {
        singleFork: false,   // Multiple workers
      },
    },
    // Each worker gets VITEST_WORKER_ID environment variable
  },
});
```

**Database naming convention**:

```typescript
// Use worker ID for database isolation
const dbName = `test_${process.env.VITEST_POOL_ID || 'default'}`;
```

---

## Acceptance Test Patterns

### JSDoc Specification Links

```typescript
/**
 * @spec THRIVE-123: De-identification must replace names consistently
 * @see docs/specs/deidentification.md
 */
describe('Transcript De-identification', () => {
  it('replaces the same name with the same token throughout', async () => {
    // Test implementation
  });
});
```

### Plain-Language Descriptions

```typescript
describe('Session Upload Flow', () => {
  it('accepts a transcript file and queues it for processing', async () => {
    // Given a tutor with an active session
    const tutor = await createTutor();

    // When they upload the transcript
    const result = await api.uploadTranscript(tutor.token, transcript);

    // Then the session is created and queued
    expect(result.status).toBe('queued');
  });
});
```

---

## Builder Patterns

### Basic Builder (Fishery)

```typescript
import { Factory } from 'fishery';

export const userFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,
  email: `user-${sequence}@example.com`,
  firstName: 'Test',
  lastName: `User${sequence}`,
  role: 'tutor',
  createdAt: new Date(),
}));

// Usage
const user = userFactory.build();                    // All defaults
const admin = userFactory.build({ role: 'admin' }); // Override role only
```

### Scenarios

```typescript
function scenarioTutorWithSessions(options = {}) {
  const { sessionCount = 5 } = options;

  const org = organizationFactory.build();
  const tutor = userFactory.build({ role: 'tutor', organizationId: org.id });
  const sessions = sessionFactory.buildList(sessionCount, { tutorId: tutor.id });

  return { org, tutor, sessions };
}
```

---

## DI/Inversify Testing

```typescript
import { Container } from 'inversify';

describe('MyService', () => {
  let container: Container;
  let service: MyService;

  beforeEach(() => {
    container = new Container();

    // Bind mocks
    container.bind('ILogger').toConstantValue({
      info: vi.fn(),
      error: vi.fn(),
    });
    container.bind(MyService).toSelf();

    service = container.get(MyService);
  });

  it('logs on initialization', () => {
    expect(mockLogger.info).toHaveBeenCalled();
  });
});
```

---

## CI/CD Integration

### Execution Order

```
1. Smoke Tests     → Fast fail if infrastructure broken
2. Unit Tests      → Fast feedback on logic errors
3. Integration     → Verify system behavior (requires Docker services)
4. E2E Tests       → Validate user journeys
```

### Package-Scoped Testing

Only run tests for affected packages using Turborepo:

```bash
pnpm turbo run test --filter=...[origin/main]
```

---

## Implementation Roadmap

### Phase 1: SOA Foundation
- [ ] Add Docker Compose test configuration
- [ ] Implement database isolation for parallel tests (per-worker DB naming)
- [ ] Create shared `TestDatabase` helper in @saga-ed/soa-test-util
- [ ] Create `__tests__/builders/` structure in key packages
- [ ] Document DI testing helpers
- [ ] Apply naming conventions to new tests

### Phase 2: SOA Rollout
- [ ] Identify existing acceptance vs regression tests
- [ ] Rename files opportunistically during related work
- [ ] Create package-specific scenarios

### Phase 3: Thrive/Coach
- [ ] Create per-repo builder directories
- [ ] Reference SOA patterns in CLAUDE.md
- [ ] Set up golden datasets when needed

---

## Documentation Structure

### Shared (soa/claude/testing/) - Cross-cutting patterns

| Document | Purpose |
|----------|---------|
| [README.md](../../testing/README.md) | Index and routing |
| [philosophy.md](../../testing/philosophy.md) | ARES framework, core principles |
| [conventions.md](../../testing/conventions.md) | File naming, directory structure |
| [builders.md](../../testing/builders.md) | Fishery patterns, test data |

### Runtime-Tier Specific

| Location | Purpose |
|----------|---------|
| [apps/node/claude/testing.md](../../../apps/node/claude/testing.md) | DI testing, DB isolation, Docker |
| [apps/web/claude/testing.md](../../../apps/web/claude/testing.md) | Vitest browser mode, Svelte, Playwright |
| [packages/node/claude/testing.md](../../../packages/node/claude/testing.md) | Node package testing patterns |

### Source Materials (Nathan's prework)

| Document | Purpose |
|----------|---------|
| [sources/testing/00-testing-overview.md](./sources/testing/00-testing-overview.md) | One-page summary |
| [sources/testing/01-testing-philosophy.md](./sources/testing/01-testing-philosophy.md) | ARES framework (original) |
| [sources/testing/02-test-conventions.md](./sources/testing/02-test-conventions.md) | File naming (original) |
| [sources/testing/03-builders-and-scenarios.md](./sources/testing/03-builders-and-scenarios.md) | Test data generation |
| [sources/testing/04-cicd-integration.md](./sources/testing/04-cicd-integration.md) | Pipeline configuration |
| [sources/testing/05-ai-agent-testing-guide.md](./sources/testing/05-ai-agent-testing-guide.md) | AI assistant guidance |

---

## Next Steps

1. ~~**Review this document**~~ - Decisions captured
2. ~~**Create documentation structure**~~ - Done: `claude/testing/` + tier-specific docs
3. **Update plan.md** - Mark Phase 6 (Testing) as decided
4. **Begin implementation** - Start with Docker test infrastructure in SOA
