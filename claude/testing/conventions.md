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

## Acceptance Tests & Specifications

**Requirement**: Every acceptance test (`.spec.test.ts` or `.spec.ts`) MUST have a spec document.

### Spec Document Location & Format

**Location**: `docs/specs/[feature-name].md` at package/app level

```markdown
# Feature Name
Brief description. Link to GitHub issue if applicable.

## Acceptance Criteria

### Scenario: Password Reset sends reset email to valid addresses
**Given** a registered user
**When** they request a password reset
**Then** system sends email with reset link
```

### Test-Spec Alignment

Each test maps to one scenario. Use comments to trace steps:

```typescript
/** @spec docs/specs/password-reset.md */
describe('Password Reset', () => {
  it('sends reset email to valid addresses', async () => {
    // Given: a registered user
    const user = await createUser({ email: 'test@example.com' });

    // When: they request a password reset
    await passwordService.requestReset(user.email);

    // Then: system sends email with reset link
    expect(mockEmailService.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: user.email, subject: /reset/i })
    );
  });
});
```

### Living Documentation

Acceptance test specs are verifiable living documentation. Running the tests confirms specs are still accurate.

- **Changing requirements** → Update spec first, then test
- **Changing test** → Verify spec still matches, update if needed
- **Review checklist**: Spec exists, `@spec` JSDoc present, scenario names match

### Agent Guidance

1. **Before writing acceptance test**: Verify spec document exists
2. **If no spec**: Create spec document first (never skip this)
3. **After changes**: Run tests to confirm spec-test alignment
