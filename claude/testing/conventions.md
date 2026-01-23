# Test Conventions

## File Naming

Pattern: `name.[type].[purpose?].test.ts`

| Type + Purpose | Pattern | Example |
|----------------|---------|---------|
| Unit + Regression | `*.unit.test.ts` | `user.unit.test.ts` |
| Unit + Acceptance | `*.unit.spec.test.ts` | `user.unit.spec.test.ts` |
| Unit + Smoke | `*.unit.smoke.test.ts` | `setup.unit.smoke.test.ts` |
| Integration + Regression | `*.int.test.ts` | `api.int.test.ts` |
| Integration + Acceptance | `*.int.spec.test.ts` | `api.int.spec.test.ts` |
| Integration + Smoke | `*.int.smoke.test.ts` | `db.int.smoke.test.ts` |
| E2E (Playwright) | `*.spec.ts` | `auth.spec.ts` |

**Rules**:
- Type suffix (`.unit.`, `.int.`) is **required**
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

## Acceptance Test Traceability

Link acceptance tests to specifications with JSDoc:

```typescript
/**
 * @spec TICKET-123: Users can reset passwords
 */
describe('Password Reset', () => {
  it('sends reset email to valid addresses', async () => {
    // ...
  });
});
```
