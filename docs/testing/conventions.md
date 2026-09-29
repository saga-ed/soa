# Test Conventions

## File Naming

Pattern: `name.[type].[purpose?].test.ts`

| Type + Purpose | Pattern | Example |
|----------------|---------|---------|
| Unit + Regression | `*.unit.test.ts` | `user.unit.test.ts` |
| Unit + Acceptance | `*.unit.spec.test.ts` | `user.unit.spec.test.ts` |
| Unit + Smoke | `*.unit.smoke.test.ts` | `setup.unit.smoke.test.ts` |
| Component + Acceptance | `*.spec.test.ts` | `Timer.spec.test.ts` |
| Component + Smoke | `*.smoke.test.ts` | `Timer.smoke.test.ts` |
| Integration + Regression | `*.int.test.ts` | `api.int.test.ts` |
| Integration + Acceptance | `*.int.spec.test.ts` | `api.int.spec.test.ts` |
| Integration + Smoke | `*.int.smoke.test.ts` | `db.int.smoke.test.ts` |
| E2E (Playwright) | `*.spec.ts` | `auth.spec.ts` |

**Rules**:
- Type suffix (`.unit.`, `.int.`) is **required** for unit and integration tests
- Component tests (rendered in a browser context) omit the type suffix, since test routing is handled by vitest project config
- Purpose suffix (`.spec.`, `.smoke.`) is **optional**
- No purpose suffix = regression test (default)

## Directory Structure

```
src/
  services/
    user-service.ts
    __tests__/
      user-service.unit.test.ts
      user-service.int.test.ts
      builders/
        user.builder.ts
      fixtures/
        sample-data.json
      helpers/
        test-container.ts
      mocks/
        external-api.ts
```

## Test Location

- Tests live in `__tests__/` adjacent to source code
- Builders, fixtures, helpers, mocks inside `__tests__/`
- E2E tests in dedicated `e2e/` directory at app level

## Test Environment (Vitest Projects)

For apps with both browser and server code, use vitest projects to run tests in the appropriate environment:

- **Browser tests** (components, UI): Run with `browser.enabled: true`
- **Server tests** (API routes, server utilities): Run with `environment: 'node'`

Configure include/exclude patterns to route tests to the correct environment. Ensure patterns account for `__tests__/` directories:

```typescript
// vite.config.ts
test: {
  projects: [
    {
      test: {
        name: 'client',
        browser: { enabled: true, ... },
        include: ['src/**/*.*.test.{js,ts}'],
        exclude: ['src/lib/server/**', 'src/lib/api/**']
      }
    },
    {
      test: {
        name: 'server',
        environment: 'node',
        include: ['src/lib/server/**/*.*.test.{js,ts}', 'src/lib/api/**/*.*.test.{js,ts}']
      }
    }
  ]
}
```

## Acceptance Tests & Specifications

**Requirement**: Every acceptance test (`.spec.test.ts`) MUST have an inline `@spec` docstring in Gherkin format.

### Spec Format

The spec lives in a JSDoc comment at the top of the describe block, using Gherkin syntax:

```typescript
/**
 * @spec Password Reset
 *
 * Feature: Password reset for registered users
 *
 * Scenario: sends reset email to valid addresses
 *   Given a registered user
 *   When they request a password reset
 *   Then system sends email with reset link
 *
 * Scenario: rejects invalid email addresses
 *   Given an unregistered email
 *   When a reset is requested
 *   Then no email is sent
 *   And an error is returned
 */
describe('Password Reset', () => {
  it('sends reset email to valid addresses', async () => {
    const user = await createUser({ email: 'test@example.com' });
    await passwordService.requestReset(user.email);
    expect(mockEmailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: user.email, subject: /reset/i })
    );
  });

  it('rejects invalid email addresses', async () => {
    const result = await passwordService.requestReset('unknown@example.com');
    expect(mockEmailService.send).not.toHaveBeenCalled();
    expect(result.error).toBeDefined();
  });
});
```

### Rules

1. Every acceptance test file has a `@spec` docstring at the top
2. The spec uses Gherkin format (Feature, Scenario, Given/When/Then)
3. Each `it()` test name matches a Scenario name exactly
4. The test implements that scenario

### Living Documentation

Acceptance test specs are verifiable living documentation. Running the tests confirms specs are still accurate.

- **Changing requirements** → Update spec first, then test
- **Changing test** → Verify spec still matches, update if needed
- **Review checklist**: `@spec` docstring present, scenario names match test names

### Agent Guidance

1. **Before writing acceptance test**: Write the `@spec` docstring first
2. **Each scenario** becomes one `it()` test with matching name
3. **After changes**: Ensure spec scenarios and test names stay aligned
