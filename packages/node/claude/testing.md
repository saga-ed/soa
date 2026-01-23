# Node Package Testing

Testing patterns for shared Node.js packages.

For shared patterns, see [claude/testing/](../../../claude/testing/).

## Package Testing Focus

Node packages are consumed by multiple apps. Tests should verify:

- **Public API contracts** (acceptance tests)
- **Edge cases in utilities** (regression tests)
- **Package can be imported** (smoke tests)

## Unit Test Pattern

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

## Testing Exported Types

Ensure type exports work as documented:

```typescript
// Type test - compilation is the test
import type { UserConfig } from '@saga-ed/soa-api-core';

const config: UserConfig = {
  timeout: 1000,
  retries: 3,
};
```

## Smoke Test Pattern

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

## Package-Specific Builders

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

## Vitest Config

Each package has its own `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```
