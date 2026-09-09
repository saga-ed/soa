# Testing Philosophy: The ARES Framework

This document establishes our testing philosophy across the Coach, Thrive, and SOA repositories. Our approach recognizes that tests serve different purposes and should be designed accordingly.

## Why We Test

Testing provides **confidence** and **documentation**:

1. **Confidence**: When code changes, tests tell us whether existing functionality still works
2. **Documentation**: Well-written tests describe what the system *actually does* **and** _what we want it to do_.  Non-test documentation can become stale and fail to describe the current behaviors and decisions made - purely regression-focused testing can ignore why we want the tested behaviors (or even _if_ we want them - testing to the code instead of to the spec)

However, not all tests serve these purposes equally. A test that breaks constantly but rarely catches real bugs undermines confidence. A test with cryptic setup and assertions provides no documentation value.

## The ARES Framework

We categorize tests by their primary **purpose** using the ARES framework:

| Purpose | What It Answers | Change Review Level |
|---------|-----------------|---------------------|
| **A**cceptance | "Does this meet the agreed requirements?" | High: Team consensus required |
| **R**egression | "Did we accidentally break something?" | Normal: Developer judgment |
| **E**xploration | "What happens if I try this?" | N/A: Not automated |
| **S**moke | "Is the test infrastructure itself working?" | Low: Rarely changes |

**When tests run**: All automated tests (Acceptance, Regression, Smoke) run on every push—whether to a PR or a working branch. Developers working between PR commits should still see test results. When branches are merged directly without PR, tests run on the target branch to catch issues early.

**Who modifies tests**: Both developers and AI agents modify all test types. The difference is in *review rigor*:
- **Acceptance test changes** warrant team discussion—these represent agreed requirements, so changing them may indicate a pivot in direction
- **Regression/Smoke test changes** require normal code review but don't need broader buy-in as long as the changes aren't spurious replacements that ignore test signals

### Acceptance Tests

**Purpose**: Living documentation that proves the system behaves as stakeholders agreed.

Acceptance tests are the most valuable pound-for-pound because they bridge the gap between documentation and reality. When an acceptance test passes, it means "the system does what we said it should."

**Characteristics**:
- Tied to a **plain-language specification** that describes the expected behavior
- Focused on *examples* that represent real use cases
- Must be maintainable—carefully chosen, not exhaustive
- Defined *before* implementation, not *after* (refinement during implementation is allowed)
- Updated when requirements change

**Plain-Language Specifications**: The *specification* is written in plain language so anyone can understand what behavior is being tested. The *test code* is still written by developers. Our primary approach:

- **Structured test descriptions**: `describe` and `it` blocks written to read as specifications, with comments linking to requirements
- **Specification comments**: JSDoc-style annotations referencing ticket IDs or spec documents

The key criterion: **when a test fails, a non-developer should be able to understand what behavior broke** from the test name and specification alone.

**Anti-patterns**:
- Testing implementation details rather than behaviors
- Writing acceptance tests after the fact to match existing behavior
- Acceptance tests that require deep technical knowledge to understand

**Example**:

```typescript
/**
 * @spec THRIVE-42: De-identification must replace names consistently
 * @see docs/specs/deidentification.md
 */
describe('Transcript De-identification', () => {
  describe('name replacement', () => {
    it('replaces the same name with the same token throughout the transcript', async () => {
      // Test implementation...
    });
    
    it('uses different tokens for different names', async () => {
      // Test implementation...
    });
  });
});
```

What matters is that the specification is clear and accessible.

### Regression Tests

**Purpose**: Tripwires that alert us when behavior changes unexpectedly.

Regression tests fill coverage gaps that acceptance tests intentionally leave. They're disposable—when a regression test breaks and the new behavior is correct, update or discard the test.

**Characteristics**:
- High coverage of edge cases and boundary conditions
- Small, focused tests that are easy to replace
- Don't require stakeholder agreement—developer judgment suffices
- When repeatedly confirmed as correct changes, consider if they reveal a missing acceptance criteria

**Anti-patterns**:
- Tests so intertwined that one change breaks dozens
- Treating regression tests as sacred (they exist to be updated)
- Testing every possible condition (diminishing returns)

```typescript
// Good: Focused regression test, easy to update
describe('Talk-time ratio calculation', () => {
  it('handles empty transcripts', () => {
    expect(calculateTalkTimeRatio([])).toEqual({ tutor: 0, student: 0 });
  });

  it('handles single-speaker transcripts', () => {
    const turns = [{ speaker: 'tutor', duration: 100 }];
    expect(calculateTalkTimeRatio(turns)).toEqual({ tutor: 1.0, student: 0 });
  });
});
```

### Exploration (Manual Testing)

**Purpose**: Discover bugs and gaps through intuition and creative investigation.

Manual exploratory testing is **not obsolete**. We use it to find things we intuitively can find but haven't expressed as tests.  There are automated forms for this, but we're not at that level yet.

**Characteristics**:
- Driven by intuition and curiosity
- Often leads to new acceptance criteria or regression tests
- Must be *easy* to do—intuition is lazy
- Requires ability to reach intermediate states quickly
- **Not scripted or automated**—this is about ad-hoc investigation, demoing, and "clicking around"

**Supporting exploration**:
- Easy scenario setup and data generation
- Clear documentation of how to run partial systems
- Reusable helpers shared with automated tests (prevents drift)
- **Same fixtures/scenarios as automated tests**: Transcript files or other "golden datasets" and generated scenarios used in automated tests should be easily loadable for manual exploration
- Tools for quickly swapping scenarios and reaching specific system states (avoiding having some behavior locked behind long user processes)

### Smoke Tests

**Purpose**: Verify the test infrastructure itself is working.

Sometimes the problem isn't your code—it's that dependencies failed to install, the database didn't start, or the test framework is misconfigured. Smoke tests catch setup issues that don't cause immediate CI failures but would void test validity or produce false passes.

**Characteristics**:
- Extremely simple tests that "never" fail under normal conditions
- Ultra-fast execution
- Run first before other test suites
- Can optionally block other suites to save resources

**When to use smoke tests** (use sparingly):

| Test Type | Smoke Test Example |
|-----------|-------------------|
| Integration | Health-check endpoint returns valid response |
| E2E | Login page renders; basic user can authenticate |
| Unit | Complex builder or mock setup produces valid data *(rare—generally avoid)* |

```typescript
// Integration smoke test: verify API is responsive
describe('API Smoke Tests', () => {
  it('health endpoint returns OK', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

// E2E smoke test: verify app loads and login works
describe('App Smoke Tests', () => {
  it('login page renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  });

  it('test user can authenticate', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'test@example.com');
    await page.fill('[name="password"]', 'testpassword');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/dashboard');
  });
});
```

## Tests Often Serve Multiple Purposes

A single test may provide both acceptance and regression value. However, optimizing for one purpose often compromises another:

| Acceptance needs... | Regression needs... |
|---------------------|---------------------|
| Carefully chosen examples | Broad coverage |
| Readable specifications | Fast execution |
| Stable over time | Easy to update/discard |
| Stakeholder review | Developer autonomy |

When purposes conflict, **write separate tests**. Don't compromise acceptance test clarity for coverage, or burden regression tests with specification overhead.  Get focused acceptance tests and then break out small regression tests where you see remaining holes.

## Coverage Guidance

**Target**: Aim for ~80% coverage on critical paths. Don't obsess over the number.

**Priorities**:
1. **Critical paths first**: Authentication, data processing pipelines, API contracts
2. **Edge cases that matter**: Known failure modes, security boundaries
3. **Skip diminishing returns**: 100% coverage often means testing trivial code

**When to stop adding tests**:
- You've covered the acceptance criteria
- You've added regression tests for likely edge cases
- Additional tests would duplicate existing coverage
- The code is simple enough that bugs would be obvious

## Pragmatic Tradeoffs

Testing guidelines exist to help, not hinder. When time-constrained or facing unusual situations:

### When to Skip Tests

- **Non-deterministic edge cases**: If a scenario can't be tested reliably, document it and skip
- **Inconvenient setups**: If testing requires excessive infrastructure, consider if the test is worth it
- **Trivial code**: Getters, simple wrappers, and pass-through functions rarely need tests

**Always flag skipped coverage for later**: Add a comment or issue noting what's not covered and why.

### When to Remove Tests

- **Coverage is high and changes are needed**: If you have 90% coverage but the tests have become fragile or flaky, it is better to trim down and rewrite important ones that get back to the same coverage
- **Tests are consistently flaky**: A flaky test that can't be fixed is worse than no test
- **Requirements changed**: Tests for deprecated features should go

**Flag removed coverage**: Note what was removed so it can be reconsidered later.

### Minimum Viable Testing

When full testing isn't viable:

1. **For bug fixes**: At minimum, add a regression test that reproduces the bug
2. **For new features**: Add at least one happy-path test; acceptance tests can follow
3. **For refactors**: Existing tests should pass; if they don't, understand why before updating

The goal is **informed tradeoffs**, not **skipping tests by default**.

## Potential Tools

> **Status: Potential** - Options we may adopt; not currently planned.

### Gherkin/BDD

For teams that want formal separation between specifications and test code, Gherkin files (with vitest-cucumber or similar) provide:

- Separate `.feature` files containing Given/When/Then specifications
- Clear mapping between business requirements and test implementations
- Non-technical stakeholders can read and validate specifications

```gherkin
# Example: deidentification.feature
Feature: Transcript De-identification

  Scenario: Student names are replaced with consistent tokens
    Given a transcript containing "John asked a question. Later, John answered."
    When the transcript is de-identified
    Then the same name is replaced with the same token throughout
    And the original name does not appear in the output
```

This adds tooling overhead to enforce discoverability of acceptance criteria.

## Test Types vs Test Purposes

**Type** describes *how* a test runs:
- **Unit**: Tests a single module with mocked dependencies
- **Integration**: Tests multiple modules working together
- **End-to-End (E2E)**: Tests the full system from user interface to database

**Purpose** describes *why* we wrote the test:
- Acceptance, Regression, Exploration, or Smoke

Any type can serve any purpose (though the bulk of Regression tests will be unit tests)

| | Unit | Integration | E2E |
|-|------|-------------|-----|
| **Acceptance** | Library contract tests | API behavior specs | User journey specs |
| **Regression** | Edge case coverage | Error handling | Cross-browser checks |
| **Smoke** | Module import checks | Service connectivity | App loads without crash |

## Subjective and Non-Deterministic Testing

> **Status: Planned** - Golden datasets and large fixtures not yet implemented.

Not all behaviors have objectively correct outputs. Thrive in particular involves AI-powered analysis where:
- Transcription quality is subjective
- QTF skill ratings involve judgment
- De-identification accuracy is probabilistic
- LLM outputs are non-deterministic

### The Golden Dataset Approach

For subjective correctness, we maintain **golden datasets**: curated input/output pairs that have been manually verified by domain experts.

**Characteristics of golden datasets**:
- Small but carefully chosen to cover important cases
- Manually reviewed and approved by people with domain expertise
- Include edge cases and known failure modes
- May be run multiple times for non-deterministic outputs (measuring consistency)

**Using golden datasets**:
- Acceptance tests can verify outputs match (or reasonably approximate) golden outputs
- Regression tests can detect *changes* in output, even if correctness is subjective
- Exploration uses golden datasets as starting points for manual investigation

### Large Fixtures and Transcript Files

Some tests require real transcript files or large data fixtures that can't be generated by builders:

**Fixture organization**:
```
packages/test-fixtures/
  transcripts/
    simple-math-tutoring.json      # Basic scenario
    complex-multi-student.json     # Edge case: multiple students
    unicode-names.json             # Edge case: international names
  golden-datasets/
    deidentification-cases.json
    qtf-analysis-cases.json
```

**Principles for fixture-heavy testing**:
- **Canonical fixtures** are versioned and shared across test types
- **Modifications should be parameterized**, not duplicated—avoid proliferating similar fixture files
- **Fixtures support exploration**: the same files used in automated tests should be easily loadable for manual testing and demos
- **Large fixtures live in dedicated packages**, not scattered throughout the codebase

### Sliding-Scale and Benchmark Criteria

Some criteria exist on a sliding scale (performance, accuracy rates, accessibility scores):

- **Baseline establishment**: Run benchmarks to establish current performance
- **Threshold testing**: Acceptance tests can verify metrics stay above thresholds
- **Trend monitoring**: Track metrics over time to detect gradual degradation
- **Benchmark tests run less frequently**: Resource-intensive benchmarks may run on merge to main, not every push

```typescript
// Example: Accuracy threshold test
describe('De-identification Accuracy', () => {
  it('achieves at least 95% detection rate on validation dataset', async () => {
    const results = await runAccuracyBenchmark(validationDataset);
    expect(results.detectionRate).toBeGreaterThanOrEqual(0.95);
  });
});
```

## Frontend Testing Strategy

> **Status: Planned** - Storybook not yet set up. Apply when frontend apps are in scope.

Frontend code has historically been difficult to test without spinning up the entire application. Our strategy addresses this by layering tools appropriately:

### The Frontend Testing Pyramid

| Layer | Tool | What It Tests | ARES Purpose |
|-------|------|---------------|--------------|
| **Utility/Logic** | Vitest (unit) | Pure functions, calculations, state logic—no DOM | Regression |
| **Component** | Storybook + Vitest | Isolated component behavior, interactions, states | Acceptance, Exploration |
| **Journey** | Playwright | Full user flows across pages, auth, real API integration | Acceptance (critical paths) |

### Vitest for Frontend Utilities

Some frontend code is purely functional—calculations, transformations, state reducers. These test exactly like backend code:

```typescript
// utils/format-duration.test.ts
describe('formatDuration', () => {
  it('formats seconds as mm:ss', () => {
    expect(formatDuration(125)).toBe('2:05');
  });
});
```

Frontend developers make the call on what qualifies—if rendering and interactions don't matter, plain Vitest is appropriate.

### Storybook for Component Testing

[Storybook](https://storybook.js.org/docs) provides the isolation layer that lets frontend developers test components the way backend developers test services—without needing the whole system running.

**Why Storybook?**
- **Isolation**: Test a button, form, or card without spinning up the entire app
- **State exploration**: Easily reach loading states, error states, edge cases that are hard to trigger in a running app
- **Behavior pinning**: Define how a component should respond to interactions (clicks, input, focus)

**How it maps to ARES**:
- **Acceptance**: Stories define agreed component states and behaviors. "This form validates email format" is an acceptance criterion implemented as a Storybook interaction test.
- **Exploration**: The Storybook UI is an exploration tool—developers can manually interact with components in various states without triggering the scenarios through the full app.
- **Regression**: Interaction tests catch behavior regressions when component logic changes.

**What Storybook is NOT (for us)**:
- **Not primarily visual regression testing**: While Storybook supports screenshot comparison, we're not prioritizing this. We don't have strict branding guidelines that require pixel-perfect consistency, and visual regression tooling can become a maintenance burden. Manual visual checking during development is preferred.
- **Not E2E testing**: Storybook tests components in isolation. It doesn't test how components work together across pages or with real backend integration.

**Example: Component acceptance test in Storybook**

```typescript
// Button.stories.ts
import type { Meta, StoryObj } from '@storybook/[framework]';
import { expect, userEvent, within } from '@storybook/test';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  component: Button,
};
export default meta;

type Story = StoryObj<typeof Button>;

// Story as acceptance criterion: "disabled buttons don't trigger onClick"
export const DisabledButtonIgnoresClicks: Story = {
  args: {
    disabled: true,
    children: 'Submit',
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button');
    
    await userEvent.click(button);
    
    // Acceptance: onClick should not be called
    expect(args.onClick).not.toHaveBeenCalled();
  },
};
```

### Playwright for User Journeys

Playwright tests what Storybook cannot: **full user journeys** that span pages, involve authentication, and integrate with real (or mocked) APIs.

Use Playwright for:
- Critical user paths (login → dashboard → action → confirmation)
- Flows that cross component boundaries
- Testing real API integration behavior
- Scenarios where component isolation would miss the bug

**Overlap is acceptable**: Some behaviors could be tested in either tool. When in doubt:
- If you're testing **component logic in isolation** → Storybook
- If you're testing **user journey across the app** → Playwright
- If it's genuinely unclear, pick one and document the choice

### Storybook Organization

Storybook can live in multiple places:

```
packages/
  ui/                          # Shared component library (if any)
    src/
      Button/
        Button.tsx
        Button.stories.ts      # Stories for shared components
apps/
  coach-app/
    src/
      components/
        SessionCard/
          SessionCard.tsx
          SessionCard.stories.ts  # App-specific component stories
```

Stories live alongside the components they test, following the same collocation principle as other tests.

## Applying ARES in Our Repos

### SOA Repository
Primary focus: **Library contracts** (acceptance) and **utility coverage** (regression)

SOA provides foundational packages. Tests should verify:
- Public APIs behave as documented (acceptance)
- Edge cases in utilities are handled (regression)
- Packages can be imported and basic operations work (smoke)

### Thrive Repository
Primary focus: **Processing pipelines** (acceptance), **data handling** (regression), and **subjective accuracy** (golden datasets)

Thrive processes transcripts through de-identification and analysis. Tests should verify:
- Processing pipeline produces expected outputs (acceptance)
- PII detection catches required patterns (acceptance)
- Edge cases in parsing don't crash (regression)
- QTF analysis returns expected structure (acceptance)

**Subjective testing considerations for Thrive**:
- De-identification accuracy against golden datasets (threshold testing)
- QTF skill ratings compared to expert-reviewed examples
- Non-deterministic LLM outputs tested for consistency across runs
- Real transcript fixtures for integration and exploration
- Manual verification workflows for new golden dataset entries

### Coach Repository
Primary focus: **API contracts** (acceptance), **integration flows** (regression), and **component behavior** (frontend acceptance)

Coach provides user-facing APIs and a complex frontend application. Tests should verify:
- API endpoints return documented responses (acceptance)
- Authentication and authorization work correctly (acceptance)
- Error conditions return appropriate responses (regression)

**Frontend testing for Coach**:
- Component behavior via Storybook (acceptance + exploration)
- Utility functions via Vitest (regression)
- Critical user journeys via Playwright (acceptance)
- Coach has significant business logic in the frontend—component isolation testing helps developers refine and pin down behaviors without spinning up the full application

## Next Steps

- [Test Conventions](./02-test-conventions.md) - File naming, locations, and patterns
- [Builders and Scenarios](./03-builders-and-scenarios.md) - Data generation for tests
- [CI/CD Integration](./04-cicd-integration.md) - Running tests in pipelines
- [Testing for AI Agents](./05-ai-agent-testing-guide.md) - Guidance for AI-assisted development
