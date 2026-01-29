# Testing Philosophy: ARES Framework

Tests are categorized by **type** (how they run) and **purpose** (why we wrote them).

## Test Types (How)

| Type | What It Tests | Tool |
|------|---------------|------|
| **Unit** | Single module with mocked dependencies | Vitest |
| **Component** | UI components in browser isolation | Vitest browser mode |
| **Integration** | Multiple modules working together | Vitest |
| **E2E** | Full system from UI to database | Playwright |

## Test Purposes (Why) - ARES

| Purpose | What It Answers | Review Level |
|---------|-----------------|--------------|
| **A**cceptance | Does this meet agreed requirements? | High: Team consensus |
| **R**egression | Did we accidentally break something? | Normal: Developer judgment |
| **E**xploration | What happens if I try this? | N/A: Manual |
| **S**moke | Is the test infrastructure working? | Low: Rarely changes |

## Core Principles

1. **Only Specify What's Special** - Test data expresses intent, not exact values
2. **Scenarios as Code** - Test setups that survive schema changes
3. **CI is Truth** - Docker-based testing matches CI; CI results are authoritative
4. **Tests Are Documentation** - Acceptance tests are living specifications
5. **JSDoc for Traceability** - `@spec TICKET-123` links tests to requirements
6. **Parallel by Default** - All tests must support parallel execution

## When to Update vs Delete Tests

| Situation | Action |
|-----------|--------|
| Test fails, new behavior is correct | Update the test |
| Test fails, unclear if change is correct | Ask the developer |
| Test is for removed feature | Delete the test |
| Flaky regression test | Delete it |
| Flaky acceptance test | Skip with GitHub issue |

## Coverage Guidance

- **Target**: ~80% on critical paths
- **Don't obsess**: Coverage numbers aren't the goal
- **Priorities**: Auth, data pipelines, API contracts first
