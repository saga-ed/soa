# Test Conventions and Patterns

This document defines the conventions for writing tests across Coach, Thrive, and SOA repositories. Consistent patterns improve discoverability, maintainability, and tooling integration.

## File Organization

### Location: Tests, Fixtures, Builders, and Helpers

#### Vitest Tests

Tests live in `__tests__` directories adjacent to the code they test:

```
packages/
  my-package/
    src/
      services/
        user-service.ts
        __tests__/
          user-service.test.ts
      utils/
        validation.ts
        __tests__/
          validation.test.ts
    package.json
    vitest.config.ts
```

**Benefits**:
- High discoverability—tests are found where you expect them
- Changes to code naturally prompt review of adjacent tests
- Package boundaries remain clear

**Cautions**
- Important to isolate what gets built
- For black box testing, important to isolate what's imported

**Alternative** (when needed for isolation): Mirror structure in a separate `test/` directory for black-box integration tests that shouldn't access internal modules.

#### Fixtures, Builders, and Test Helpers

Test support code has its own organization:

```
packages/
  my-package/
    src/
      __tests__/
        builders/           # Factories for this package's types
          user.builder.ts
          session.builder.ts
          index.ts          # Re-exports all builders
        fixtures/           # Static test data files
          sample-transcript.json
        helpers/            # Test utilities specific to this package
          create-test-db.ts
        mocks/              # Module mocks
          external-api.ts
        user-service.test.ts
        
  # Shared across packages (Planned - not yet implemented)
  test-utils/               # Separate package for shared test infrastructure
    src/
      builders/             # Builders for shared types
      fixtures/             # Large fixtures (transcripts, golden datasets)
      helpers/              # Common test utilities
      index.ts
```

**Guidelines**:
- **Builders**: Package-specific builders live in `__tests__/builders/`. Shared builders (for types used across packages) live in a `test-utils` package *(Planned)*.
- **Fixtures**: Small fixtures can live in `__tests__/fixtures/`. Large fixtures (transcript files, golden datasets) should live in a shared `test-utils` or `test-fixtures` package to avoid duplication and enable exploration *(Planned)*.
- **Helpers**: Test utilities live in `__tests__/helpers/` or shared `test-utils` *(Planned)*.
- **Mocks**: Module mocks live in `__mocks__/` (vitest convention) adjacent to `__tests__/`.

#### Storybook Tests

Stories live alongside components, not in `__tests__`:

```
src/
  components/
    Button/
      Button.tsx
      Button.stories.ts
      Button.module.css
```

#### Playwright E2E Tests

E2E tests typically live in a dedicated top-level directory:

```
apps/
  coach-app/
    e2e/                    # Playwright tests
      auth.spec.ts
      dashboard.spec.ts
      fixtures/             # E2E-specific fixtures
    src/
      ...
```

### File Naming Conventions

> **Status: Current (convention defined, not yet fully applied)** - Existing tests may not follow these conventions yet.

#### Vitest/Backend Tests

All vitest test files end in `.test.ts`. Purpose is indicated by an additional suffix:

| Test Purpose | File Pattern | Example |
|--------------|--------------|---------|
| Regression (default) | `*.test.ts` | `user-service.test.ts` |
| Acceptance/Spec | `*.spec.test.ts` | `user-service.spec.test.ts` |
| Integration | `*.int.test.ts` | `api.int.test.ts` |
| Smoke | `*.smoke.test.ts` | `infrastructure.smoke.test.ts` |

This keeps all tests discoverable by `*.test.ts` globs while allowing filtering by purpose.

#### Storybook Tests

Storybook uses its own convention—stories are not `.test.ts` files:

| File Pattern | Purpose |
|--------------|---------|
| `*.stories.ts` | Component stories and interaction tests |
| `*.stories.tsx` | Stories that need JSX (rare) |

Stories use PascalCase to match component names: `Button.tsx` → `Button.stories.ts`

#### Playwright E2E Tests

Playwright has its own conventions (typically `*.spec.ts` in a dedicated `e2e/` directory). These are separate from vitest tests and don't need the `.test.ts` suffix since Playwright has its own runner.

#### General Rules

- Use kebab-case for backend test filenames: `user-service.test.ts`
- Match the source file name when practical: `validation.ts` → `validation.test.ts`
- One test file per source file is common, but not required—group logically

### Vitest Configuration

Each package has its own `vitest.config.ts`. This enables:
- Running tests from project root: `pnpm -r test`
- Running package-specific tests: `cd packages/db && pnpm test`
- Different configurations per package when needed

Standard configuration pattern:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/__tests__/**/*.test.ts',  // All tests end in .test.ts
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/mocks/**',
      ],
    },
  },
});
```

The `*.test.ts` glob catches all test types (`.spec.test.ts`, `.int.test.ts`, `.smoke.test.ts`). Filter by purpose using include/exclude patterns in scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --exclude '**/*.int.test.ts'",
    "test:int": "vitest run --include '**/*.int.test.ts'",
    "test:smoke": "vitest run --include '**/*.smoke.test.ts'",
    "test:spec": "vitest run --include '**/*.spec.test.ts'"
  }
}
```

## Test Structure

### Arrange-Act-Assert (AAA)

Every test follows the AAA pattern with clear visual separation:

```typescript
it('creates a user with hashed password', async () => {
  // Arrange
  const input = { email: 'test@example.com', password: 'secret123' };

  // Act
  const user = await userService.create(input);

  // Assert
  expect(user.email).toBe('test@example.com');
  expect(user.passwordHash).not.toBe('secret123');
  expect(user.passwordHash).toHaveLength(60); // bcrypt hash length
});
```

For simple tests, comments are optional but structure should be evident:

```typescript
it('returns empty array for no matches', () => {
  const result = searchUsers([]);
  expect(result).toEqual([]);
});
```

### Test Descriptions

Use descriptive `describe` blocks and `it`/`test` statements that read as specifications:

```typescript
// Good: Reads as a specification
describe('DeidentificationService', () => {
  describe('replaceNames', () => {
    it('replaces first and last names with tokens', () => { ... });
    it('uses consistent tokens for the same name', () => { ... });
    it('handles names with apostrophes', () => { ... });
  });
});

// Bad: Vague or implementation-focused
describe('DeidentificationService', () => {
  it('works', () => { ... });
  it('test case 1', () => { ... });
  it('calls the regex correctly', () => { ... });
});
```

**Pattern**: `it('should/does [action] when [condition]')` or simply `it('[action] when [condition]')`

### Grouping Related Tests

Use `describe` blocks to group related tests. The grouping should make it easy to understand what's being tested and find related tests. Common approaches:

- Group by class/module, then by method
- Group by feature or behavior
- Group by scenario (given/when conditions)

The exact nesting structure matters less than clarity. These are all reasonable:

```typescript
// Option 1: By module and method
describe('AnalysisService', () => {
  describe('analyzeTranscript', () => {
    it('returns skill scores for valid input', () => { ... });
    it('returns neutral scores for empty transcript', () => { ... });
  });
});

// Option 2: By scenario
describe('Transcript Analysis', () => {
  describe('with valid transcript', () => {
    it('returns skill scores', () => { ... });
    it('includes evidence snippets', () => { ... });
  });
  
  describe('with empty transcript', () => {
    it('returns neutral scores', () => { ... });
  });
});

// Option 3: Flat when tests are few and focused
describe('calculateTalkTimeRatio', () => {
  it('handles empty transcripts', () => { ... });
  it('handles single-speaker transcripts', () => { ... });
  it('calculates ratio for mixed speakers', () => { ... });
});
```

Tests can also be grouped by **file** (one test file per logical area) or **directory** (subdirectories for major features) when that improves organization.

## Assertion Patterns

### Prefer Specific Assertions

```typescript
// Good: Specific assertions
expect(user.email).toBe('test@example.com');
expect(users).toHaveLength(3);
expect(error.message).toContain('not found');

// Bad: Truthy checks hide problems
expect(user.email).toBeTruthy();
expect(users.length > 0).toBe(true);
```

### Object Matching

**Prefer partial matches** (`toMatchObject`) over exact matches (`toEqual`) for objects with many properties. This follows the "only specify what's special" principle—tests should assert what matters for the test, not every field.

```typescript
// Good: Assert only what matters for this test
expect(user).toMatchObject({
  role: 'admin',
  permissions: expect.arrayContaining(['delete']),
});

// Good: Check specific properties individually for clarity
expect(user.email).toBe('test@example.com');
expect(user.role).toBe('tutor');
expect(user.createdAt).toBeInstanceOf(Date);

// Avoid: Exact match on large objects (brittle, hard to read)
expect(user).toEqual({
  id: 'user-123',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  role: 'tutor',
  organizationId: 'org-456',
  createdAt: expect.any(Date),
  updatedAt: expect.any(Date),
  // ... many more fields
});
```

Use `toEqual` for small, well-defined response structures where exact shape matters:

```typescript
// Fine: Small response where exact structure is the contract
expect(response).toEqual({
  success: true,
  data: { id: '123' },
});
```

### Async Error Assertions

```typescript
// Good: Specific error checking
await expect(userService.findById('invalid')).rejects.toThrow('not found');

// Or with more detail
await expect(userService.findById('invalid')).rejects.toMatchObject({
  code: 'NOT_FOUND',
  message: expect.stringContaining('invalid'),
});
```

## Mocking Patterns

### Mock Placement

Place mocks in a `__mocks__` directory adjacent to `__tests__`:

```
src/
  services/
    external-api.ts
    __tests__/
      external-api.test.ts
    __mocks__/
      external-api.ts
```

### Mock Creation

```typescript
// For simple function mocks
const mockSendEmail = vi.fn();

// For module mocks with type safety
vi.mock('../external-api', () => ({
  ExternalApi: {
    fetch: vi.fn(),
    post: vi.fn(),
  },
}));

// Access the mock for assertions
import { ExternalApi } from '../external-api';
const mockedApi = vi.mocked(ExternalApi);
```

### Reset Mocks Between Tests

```typescript
beforeEach(() => {
  vi.clearAllMocks();
});

// Or in vitest.config.ts:
export default defineConfig({
  test: {
    clearMocks: true,
  },
});
```

## Acceptance Test Patterns

Acceptance tests (`.spec.test.ts`) have additional requirements for clarity.

### Plain Language Descriptions

```typescript
describe('Session Upload Flow', () => {
  it('accepts a transcript file and queues it for processing', async () => {
    // Given a tutor with an active session
    const tutor = await createTutor();
    const transcript = fixtures.validTranscript();

    // When they upload the transcript
    const result = await api.uploadTranscript(tutor.token, transcript);

    // Then the session is created and queued
    expect(result.status).toBe('queued');
    expect(result.sessionId).toBeDefined();
  });
});
```

### Gherkin-Style (Potential)

> **Status: Potential** - An option we may adopt; not currently planned.

For complex acceptance criteria, consider Gherkin syntax with a vitest plugin:

```gherkin
# features/deidentification.feature
Feature: Transcript De-identification
  
  Scenario: Student names are replaced with tokens
    Given a transcript containing "John asked about math"
    When the transcript is de-identified
    Then the output contains "STUDENT_1 asked about math"
    And no personally identifiable information remains
```

Plain-language `describe`/`it` blocks achieve most of this benefit with less tooling overhead.

### Linking to Specifications

How acceptance tests link to specifications is still evolving. Possible approaches:

1. **Gherkin files**: Specifications live in `.feature` files, enforced by a vitest/playwright plugin. The link is implicit—the spec *is* the test definition.

2. **JSDoc annotations**: Reference tickets or documents in comments:
   ```typescript
   /**
    * @spec THRIVE-123: De-identification must achieve 95% PII detection
    */
   describe('De-identification Accuracy', () => { ... });
   ```

3. **Naming conventions**: Test file/describe names match specification names, with AI or review confirming alignment.

4. **Specification documents**: Specs live in `docs/specs/` and tests reference them, with periodic review to catch drift.

The key requirement is **traceability**: when a test fails, someone should be able to find the specification it's testing. When a specification changes, affected tests should be identifiable.

We'll refine this as we establish our specification workflow. For now, clear test descriptions that read as specifications (see "Plain Language Descriptions" above) are the baseline.

## Integration Test Patterns

### Setup and Teardown

```typescript
describe('API Integration', () => {
  let app: Express;

  beforeAll(async () => {
    // Start the server once for all tests
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean state between tests
    await db.truncateAll();
  });
});
```

### Database Isolation

```typescript
// Option 1: Truncate tables between tests
beforeEach(async () => {
  await prisma.user.deleteMany();
  await prisma.session.deleteMany();
});

// Option 2: Transaction rollback (faster)
let tx: Transaction;
beforeEach(async () => {
  tx = await db.beginTransaction();
});
afterEach(async () => {
  await tx.rollback();
});
```

### API Testing with Supertest

```typescript
import request from 'supertest';

it('returns 401 for unauthenticated requests', async () => {
  const response = await request(app)
    .get('/api/sessions')
    .expect(401);

  expect(response.body).toMatchObject({
    error: 'Authentication required',
  });
});
```

## Storybook Patterns (Frontend Components)

> **Status: Planned** - Storybook not yet set up. Apply when frontend apps are in scope.

Storybook tests frontend components in isolation. Stories serve as both acceptance tests and exploration tools.

### File Organization

Stories live alongside components (not in `__tests__`):

```
src/
  components/
    Button/
      Button.tsx
      Button.stories.ts    # Stories colocated with component
      Button.module.css
    SessionCard/
      SessionCard.tsx
      SessionCard.stories.ts
```

### Story File Naming

| File Pattern | Purpose |
|--------------|---------|
| `*.stories.ts` | Component stories and interaction tests |
| `*.stories.tsx` | Stories that need JSX (rare—prefer `.ts` with CSF) |

### Story Structure

Use Component Story Format (CSF) 3:

```typescript
// Button.stories.ts
import type { Meta, StoryObj } from '@storybook/[framework]';
import { Button } from './Button';

// Meta describes the component
const meta: Meta<typeof Button> = {
  component: Button,
  title: 'Components/Button',  // Optional: controls sidebar organization
  tags: ['autodocs'],          // Optional: generates documentation
};
export default meta;

type Story = StoryObj<typeof Button>;

// Each export is a story (a component state)
export const Primary: Story = {
  args: {
    variant: 'primary',
    children: 'Click me',
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: 'Cannot click',
  },
};
```

### Interaction Tests

Use the `play` function for behavior testing:

```typescript
import { expect, userEvent, within } from '@storybook/test';

export const FormValidation: Story = {
  args: {
    onSubmit: fn(),  // Mock function from @storybook/test
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    
    // Arrange: Find elements
    const emailInput = canvas.getByLabelText('Email');
    const submitButton = canvas.getByRole('button', { name: 'Submit' });
    
    // Act: Invalid submission
    await userEvent.type(emailInput, 'not-an-email');
    await userEvent.click(submitButton);
    
    // Assert: Form shows error, doesn't submit
    expect(canvas.getByText('Invalid email')).toBeInTheDocument();
    expect(args.onSubmit).not.toHaveBeenCalled();
    
    // Act: Valid submission
    await userEvent.clear(emailInput);
    await userEvent.type(emailInput, 'valid@example.com');
    await userEvent.click(submitButton);
    
    // Assert: Form submits
    expect(args.onSubmit).toHaveBeenCalledWith({ email: 'valid@example.com' });
  },
};
```

### When to Write Stories

**Write stories for**:
- Reusable components (buttons, inputs, cards)
- Components with multiple states (loading, error, empty, populated)
- Complex interactions (forms, modals, dropdowns)
- Components with acceptance criteria worth pinning down

**Skip stories for**:
- Simple wrapper components with no logic
- Layout components that just arrange children
- One-off components unlikely to be reused

### Running Storybook Tests

```json
{
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "storybook:build": "storybook build",
    "storybook:test": "test-storybook"
  }
}
```

```bash
# Interactive exploration
pnpm storybook

# Run interaction tests in CI
pnpm storybook:test
```

## Smoke Test Patterns

Smoke tests verify that test infrastructure is working. They catch setup issues that don't cause immediate CI failures but would void test validity or produce false passes.

### When to Write Smoke Tests

| Test Type | Smoke Test Example |
|-----------|-------------------|
| Integration | Health-check endpoint returns valid response |
| E2E | Login page renders; basic user can authenticate with scenario data |
| Unit | Complex builder/mock logic produces valid output *(rare—try to avoid hard to validate logic here)* |

### Integration Smoke Tests

```typescript
// api.smoke.test.ts
describe('API Smoke Tests', () => {
  it('health endpoint returns OK', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('database connection is available', async () => {
    const result = await db.raw('SELECT 1');
    expect(result).toBeDefined();
  });
});
```

### E2E Smoke Tests

```typescript
// e2e/smoke.spec.ts
describe('App Smoke Tests', () => {
  it('login page renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  });

  it('test user can authenticate', async ({ page }) => {
    // Uses scenario data seeded before test run
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'testpassword');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/dashboard');
  });
});
```

### What NOT to Smoke Test

Avoid smoke tests that just check module imports—if an import fails, other tests will fail with a clear error anyway. Focus smoke tests on infrastructure that might silently fail or produce misleading results.

## Running Tests

### NPM Scripts (Vitest)

Common scripts for vitest packages:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:unit": "vitest run --exclude '**/*.int.test.ts'",
    "test:int": "vitest run --include '**/*.int.test.ts'",
    "test:smoke": "vitest run --include '**/*.smoke.test.ts'",
    "test:spec": "vitest run --include '**/*.spec.test.ts'"
  }
}
```

### NPM Scripts (Storybook)

For packages with Storybook:

```json
{
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "storybook:build": "storybook build",
    "storybook:test": "test-storybook"
  }
}
```

### NPM Scripts (Playwright)

For apps with E2E tests:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

### CI Script Patterns

```bash
# Run smoke tests first (fast fail)
pnpm test:smoke || exit 1

# Then unit/regression tests
pnpm test:unit

# Then integration tests (may require services)
pnpm test:int

# Then Storybook interaction tests (if applicable)
pnpm storybook:test

# Finally E2E tests (if applicable)
pnpm test:e2e
```

## Related Documents

- [Testing Philosophy](./01-testing-philosophy.md) - Why we test this way
- [Builders and Scenarios](./03-builders-and-scenarios.md) - Data generation
- [CI/CD Integration](./04-cicd-integration.md) - Pipeline configuration
