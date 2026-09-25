# Builders and Scenarios

> **Status: Planned** - No builders implemented yet. This document defines patterns for future implementation. Refer to actual code once builders are available for working examples.

Test data management is one of the biggest sources of test maintenance burden. This document establishes patterns for creating test data that is easy to write, read, and maintain.

## Core Principles

### 1. Only Specify What's Special

A scenario should describe **only what makes it unique**. Everything else uses defaults.

```typescript
// Bad: Specifying irrelevant details
const user = buildUser({
  id: 'user-123',
  email: 'test@example.com',
  firstName: 'John',
  lastName: 'Doe',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  role: 'tutor',
  organizationId: 'org-456',
});

// Good: Only what matters for this test
const user = buildUser({ role: 'admin' });
```

**Why this matters**:
- **Clarity**: When reading a test, you immediately know what's load-bearing
- **Maintenance**: Changing a field doesn't break tests that don't care about it
- **Reduced surface area**: Fewer specified values = fewer places for bugs to hide

### 2. Scenarios as Code

Test scenarios should be executable code that produces consistent *meanings*, even as the exact data changes.

```typescript
// The scenario is "an organization with many students"
// NOT "organization org-123 with exactly these 1000 student records"
function scenarioOrgWithManyStudents() {
  const org = buildOrganization();
  const students = buildUsers({ role: 'student', count: 1000, organizationId: org.id });
  return { org, students };
}
```

When builder implementations change (new required fields, validation rules, etc.), scenarios remain valid because they express *intent*, not exact data.

### 3. Versioned Data Types

When data schemas evolve, we need builders that can produce both old and new formats:

```typescript
// Schema v1: name was a single string
const userV1 = buildUserV1({ name: 'John Doe' });

// Schema v2: name split into firstName/lastName
const userV2 = buildUser({ firstName: 'John', lastName: 'Doe' });

// Tests for migration code need both
it('migrates v1 users to v2 format', () => {
  const input = buildUserV1({ name: 'John Doe' });
  const result = migrateUserV1ToV2(input);
  expect(result.firstName).toBe('John');
  expect(result.lastName).toBe('Doe');
});
```

Some scenarios will need to use specific versions (or even mixed versions) of builders.  Some will use latest versions.

This means all types that may have multiple versions (at least data types that aren't strictly migrated, but also potentially APIs/clients in some cases) need versioned types.

## Builder Implementation

We recommend [Fishery](https://github.com/thoughtbot/fishery) for builder implementation, but the patterns work with any factory library.

### Basic Builder Pattern

```typescript
// builders/user.builder.ts
import { Factory } from 'fishery';
import { User } from '../types';

export const userFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,
  email: `user-${sequence}@example.com`,
  firstName: 'Test',
  lastName: `User${sequence}`,
  role: 'tutor',
  organizationId: 'org-default',
  createdAt: new Date(),
  updatedAt: new Date(),
}));

// Usage
const user = userFactory.build();                    // All defaults
const admin = userFactory.build({ role: 'admin' }); // Override role only
const users = userFactory.buildList(5);             // Array of 5 users
```

### Unique and Arbitrary Values

Builders produce **unique** values (no collisions between instances) that are **arbitrary** but **consistent** (not random—same sequence produces same data).

```typescript
const userFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,           // Unique per instance
  email: `user-${sequence}@test.com`, // Unique per instance
  firstName: 'Test',                 // Consistent default
  // ...
}));

// This produces:
// user-1, user-2, user-3... (predictable, not random)
```

### Reasonable Defaults

Defaults should represent **typical** data, not just valid data:

```typescript
// Bad: Technically valid but unrealistic
const addressFactory = Factory.define<Address>(() => ({
  street: 'x',
  city: 'y',
  zip: '1',
}));

// Good: Reasonable, realistic defaults
const addressFactory = Factory.define<Address>(({ sequence }) => ({
  street: `${100 + sequence} Main Street`,
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'USA',
}));
```

### Transient Parameters and Traits

Use transient parameters for complex builder logic:

```typescript
const userFactory = Factory.define<User, { withSessions: number }>(
  ({ sequence, transientParams }) => {
    const user: User = {
      id: `user-${sequence}`,
      email: `user-${sequence}@example.com`,
      // ...
    };
    return user;
  }
);

// Build user, then separately build sessions if needed
const user = userFactory.build();
const sessions = sessionFactory.buildList(5, { tutorId: user.id });
```

Use traits for common variations:

```typescript
const userFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,
  email: `user-${sequence}@example.com`,
  role: 'tutor',
  isActive: true,
}))
  .trait('admin', { role: 'admin' })
  .trait('inactive', { isActive: false })
  .trait('student', { role: 'student' });

// Usage
const admin = userFactory.build({ traits: ['admin'] });
const inactiveStudent = userFactory.build({ traits: ['inactive', 'student'] });
```

## Builder Organization

### Directory Structure

```
packages/
  my-package/
    src/
      __tests__/
        builders/
          index.ts           # Re-exports all builders
          user.builder.ts
          session.builder.ts
          transcript.builder.ts
        scenarios/
          index.ts           # Re-exports all scenarios
          org-with-many-students.ts
          tutor-with-sessions.ts
```

### Shared Builders

For types shared across packages, create builders in a shared location:

```
packages/
  test-utils/
    src/
      builders/
        user.builder.ts
        organization.builder.ts
      scenarios/
        common-scenarios.ts
      index.ts
```

Packages depend on `test-utils` for shared builders:

```json
{
  "devDependencies": {
    "@repo/test-utils": "workspace:*"
  }
}
```

## Scenarios

Scenarios are **named collections of test data** that represent meaningful system states.

### Simple Scenarios

```typescript
// scenarios/empty-organization.ts
import { organizationFactory, userFactory } from '../builders';

export function scenarioEmptyOrganization() {
  const org = organizationFactory.build({ name: 'Empty Org' });
  const admin = userFactory.build({ 
    role: 'admin', 
    organizationId: org.id 
  });
  
  return { org, admin };
}
```

### Complex Scenarios

```typescript
// scenarios/active-tutoring-program.ts
import { 
  organizationFactory, 
  userFactory, 
  sessionFactory, 
  transcriptFactory,
  analysisFactory,
} from '../builders';

export interface ActiveTutoringProgramScenario {
  org: Organization;
  tutors: User[];
  students: User[];
  sessions: Session[];
  analyses: Analysis[];
}

export function scenarioActiveTutoringProgram(
  options: { tutorCount?: number; sessionsPerTutor?: number } = {}
): ActiveTutoringProgramScenario {
  const { tutorCount = 3, sessionsPerTutor = 5 } = options;
  
  const org = organizationFactory.build();
  
  const tutors = userFactory.buildList(tutorCount, {
    role: 'tutor',
    organizationId: org.id,
  });
  
  const students = userFactory.buildList(tutorCount * 2, {
    role: 'student',
    organizationId: org.id,
  });
  
  const sessions: Session[] = [];
  const analyses: Analysis[] = [];
  
  for (const tutor of tutors) {
    const tutorSessions = sessionFactory.buildList(sessionsPerTutor, {
      tutorId: tutor.id,
      organizationId: org.id,
    });
    sessions.push(...tutorSessions);
    
    for (const session of tutorSessions) {
      const analysis = analysisFactory.build({ sessionId: session.id });
      analyses.push(analysis);
    }
  }
  
  return { org, tutors, students, sessions, analyses };
}
```

### Using Scenarios in Tests

```typescript
describe('Organization Dashboard', () => {
  it('shows aggregated tutor metrics', async () => {
    // Arrange
    const scenario = scenarioActiveTutoringProgram({ tutorCount: 5 });
    await seedDatabase(scenario);
    
    // Act
    const dashboard = await getDashboard(scenario.org.id);
    
    // Assert
    expect(dashboard.tutorCount).toBe(5);
    expect(dashboard.sessionCount).toBe(25); // 5 tutors × 5 sessions
  });
});
```

### Scenarios Across Test Types

The same scenario definitions should be usable across different testing contexts:

| Test Type | How Scenarios Are Used |
|-----------|------------------------|
| **Unit tests** | Scenario data is used directly or injected into mocks |
| **Integration tests** | Scenario is seeded into a real (test) database |
| **E2E / Playwright** | Scenario is seeded before test run, possibly via API or CLI tool |
| **Exploration** | Scenario can be loaded interactively for manual testing |

The exact mechanisms will vary:
- Unit tests might use builders directly without persistence
- Integration tests use a `seedDatabase()` helper
- E2E tests might call a setup API endpoint or run a CLI script before the test
- Exploration might use a dev tool or script to load a scenario into a running environment

The key principle: **scenarios are defined once, applied many ways**. We don't yet have a single prescribed approach for all contexts—this will evolve as we build out the testing infrastructure. What matters is that scenario definitions remain reusable across these contexts.

## Managing Entity Relationships

When entities have relationships (sessions belong to tutors, tutors belong to organizations), test data creation can become complex. There's tension between:

- **Explicit composition**: Clear about what's created, but can require boilerplate
- **Implicit creation**: Convenient, but hides relationships and creates unnecessary data

### The Root Cause: Code Coupling

If building test data requires extensive relationship setup, that's often a sign that the **code under test** has tight coupling. Consider:

- Can the code accept IDs/references instead of full objects?
- Can the code work with minimal context for its actual purpose?
- Are there unnecessary dependencies that could be removed?

Sometimes the answer is "yes, this relationship is essential"—but often, simplifying the code also simplifies testing.

### Anti-pattern: Hidden Entity Creation

```typescript
// Problematic: Building a session implicitly creates org, tutor, student...
const session = buildSession(); 
// What did this create? What IDs do I use? What's in my mock DB now?
```

Problems:
- Tests become slow (creating unnecessary entities)
- Relationships are hidden (hard to understand what exists)
- Can't build just what you need for a specific test

### Better: Explicit When It Matters

```typescript
// When the test cares about the tutor-session relationship
const tutor = buildUser({ role: 'tutor' });
const session = buildSession({ tutorId: tutor.id });
```

But don't over-apply this. If your test doesn't care about the tutor:

```typescript
// Fine: Let the builder provide a default tutorId
const session = buildSession();
// The test doesn't care who the tutor is, so don't specify
```

### Scenarios for Common Setups

When you find yourself repeatedly composing the same entities, that's a scenario:

```typescript
// Instead of repeating this composition everywhere...
const org = buildOrganization();
const tutor = buildUser({ role: 'tutor', organizationId: org.id });
const session = buildSession({ tutorId: tutor.id, organizationId: org.id });

// ...create a scenario
const { org, tutor, session } = scenarioTutorWithSession();
```

Scenarios encapsulate common setups while keeping the composition visible (you can read the scenario function to see what it creates).

### Balance: Only Specify What's Special

The "only specify what's special" principle still applies:
- If your test is about **admin permissions**, specify `role: 'admin'`
- If your test is about **session analysis**, let the builder provide default org/tutor
- If your test is about **tutor-student relationships**, use a scenario that sets those up

Don't create boilerplate just because entities are related. Create boilerplate when your test actually cares about that relationship.

## Input vs Data Builders

There is a difference between:
- **Input builders**: What you send *to* an API or function
- **Data builders**: What exists *in* the database

```typescript
// Input builder: CreateUserInput (what the API receives)
export const createUserInputFactory = Factory.define<CreateUserInput>(() => ({
  email: 'new@example.com',
  password: 'password123',
  firstName: 'New',
  lastName: 'User',
}));

// Data builder: User (what's stored in DB)
export const userFactory = Factory.define<User>(({ sequence }) => ({
  id: `user-${sequence}`,
  email: `user-${sequence}@example.com`,
  passwordHash: '$2b$10$hashedpassword',
  firstName: 'Test',
  lastName: `User${sequence}`,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
```

## Seeding Databases

For integration tests, scenarios need to be persisted:

```typescript
// test-utils/seed.ts
import { prisma } from '@repo/db';

export async function seedDatabase(scenario: {
  org?: Organization;
  users?: User[];
  sessions?: Session[];
}) {
  if (scenario.org) {
    await prisma.organization.create({ data: scenario.org });
  }
  if (scenario.users) {
    await prisma.user.createMany({ data: scenario.users });
  }
  if (scenario.sessions) {
    await prisma.session.createMany({ data: scenario.sessions });
  }
}

// In test
beforeEach(async () => {
  const scenario = scenarioActiveTutoringProgram();
  await seedDatabase(scenario);
});
```

## Golden Datasets

For subjective criteria (AI analysis accuracy, transcription quality), maintain curated "golden datasets":

```typescript
// golden-datasets/deidentification-validation.ts
export const goldenDeidentificationDataset = [
  {
    id: 'case-1',
    input: 'Hello John, this is Mary calling about your son Billy.',
    expectedOutput: 'Hello PERSON_1, this is PERSON_2 calling about your son PERSON_3.',
    notes: 'Basic name replacement',
  },
  {
    id: 'case-2', 
    input: 'Call me at 555-123-4567',
    expectedOutput: 'Call me at PHONE_1',
    notes: 'Phone number detection',
  },
  // ... curated cases
];
```

(many "golden datasets" are going to be full files or collections of files, not written inline)

Golden datasets:
- Are manually verified for correctness
- Cover known edge cases and failure modes
- Are used for acceptance testing and regression checking
- May be run multiple times (for non-deterministic outputs)

## Related Documents

- [Testing Philosophy](./01-testing-philosophy.md) - Why these patterns matter
- [Test Conventions](./02-test-conventions.md) - File organization
- [CI/CD Integration](./04-cicd-integration.md) - Running tests in pipelines
