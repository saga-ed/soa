# Test Data: Builders & Scenarios

We use [Fishery](https://github.com/thoughtbot/fishery) for test data factories.

## Core Principle: Only Specify What's Special

```typescript
// Bad: Over-specified
const user = buildUser({
  id: 'user-123',
  email: 'test@example.com',
  firstName: 'John',
  role: 'admin',
});

// Good: Only what matters for this test
const user = buildUser({ role: 'admin' });
```

## Basic Builder Pattern

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
const user = userFactory.build();
const admin = userFactory.build({ role: 'admin' });
const users = userFactory.buildList(5);
```

## Scenarios

Named collections of test data for common setups:

```typescript
function scenarioTutorWithSessions(options = {}) {
  const { sessionCount = 5 } = options;
  const org = organizationFactory.build();
  const tutor = userFactory.build({
    role: 'tutor',
    organizationId: org.id
  });
  const sessions = sessionFactory.buildList(sessionCount, {
    tutorId: tutor.id
  });
  return { org, tutor, sessions };
}
```

## Builder Location

- **Shared utilities**: `@saga-ed/soa-test-util` (Fishery helpers only)
- **Domain builders**: Per-repo in `__tests__/builders/`

Each repo maintains its own domain builders (users, sessions, etc.).

## Assertion Style

Prefer partial matches:

```typescript
// Good: Assert only what matters
expect(user).toMatchObject({ role: 'admin' });

// Avoid: Exact match on large objects
expect(user).toEqual({ /* every field */ });
```
