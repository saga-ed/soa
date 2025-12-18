# Unit Testing Specification for Project Submodules

## 1. Testing Framework

- Use **Jest** as the standard testing framework for all submodules.
- Each submodule should have its own Jest configuration, extending a shared base if possible.

## 2. Test File Naming Conventions

- Test files must use kebab-case and be suffixed with `.test.ts` (e.g., `user-service.test.ts`).
- Place test files either:
  - Alongside the code they test, or
  - In a dedicated `__tests__` directory within the submodule.

## 3. Environment Configuration

- Use a `.env.test` file for test-specific environment variables in each submodule.
- Ensure Jest loads `.env.test` before running tests (using `dotenv` or `dotenv-flow`).

## 4. Test Structure and Best Practices

- Use descriptive `describe` and `it`/`test` blocks.
- Mock external dependencies and side effects.
- Ensure tests are isolated and can run in any order.
- Use clear, consistent naming for test cases (e.g., `should do X when Y`).
- Aim for high coverage, but prioritize meaningful tests over 100% coverage.

## 5. Jest Configuration

- Extend a shared Jest base config (e.g., `@saga-ed/jest-config`).
- Configure TypeScript support via `ts-jest`.
- Set up coverage reporting and test environment (e.g., `node`).

## 6. Example Directory Structure

```
packages/
  my-module/
    src/
      my-feature.ts
      __tests__/
        my-feature.test.ts
    .env.test
    jest.config.ts
```

## 7. Sample Jest Config (`jest.config.ts`)

```typescript
import baseConfig from '@saga-ed/jest-config';

export default {
  ...baseConfig,
  setupFiles: ['dotenv/config'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
};
```

## 8. Sample Test File

```typescript
import { myFunction } from '../my-feature';

describe('myFunction', () => {
  it('should return true for valid input', () => {
    expect(myFunction('valid')).toBe(true);
  });
});
```

## 9. Documentation and Enforcement

- This specification is documented in `memory-bank/03.unit-testing.md`.
- A corresponding rule file `.cursor/rules/unit-testing.mdc` enforces these conventions across the project.

## Build and Test Verification Rule

After each revision to the project, verify that the project builds and all tests pass. This ensures code quality and prevents regressions.
