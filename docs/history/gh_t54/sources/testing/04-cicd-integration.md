# CI/CD Integration and Test Workflow

Tests are only valuable if they're run. This document establishes patterns for integrating tests into our development workflow and CI/CD pipelines.

## Core Principle: Anti-"It Built on My Machine"

CI is the source of truth. If tests pass locally but fail in CI, the CI result is authoritative. This requires:

1. **Local tests match CI as close as possible** - Same environment, same results
2. **CI results are visible** - Easy to find, easy to interpret
3. **CI is fast and reliable** - Slow/flaky CI gets ignored

## Test Execution Strategy

### Execution Order

```
1. Smoke Tests     → Fast fail if infrastructure broken
2. Unit Tests      → Fast feedback on logic errors
3. Integration/Component Tests → Verify system behavior
4. E2E Tests       → Validate user journeys (when applicable)
```

### Package-Scoped Testing

Only run tests for packages affected by changes. Turborepo and similar monorepo tools can detect which packages changed and only run their tests.

**Benefits**:
- Faster CI runs
- Clearer failure attribution
- Better parallelization

The exact implementation depends on tooling choices. Turborepo's `--filter` flag is one approach; other monorepo tools have similar capabilities. The key is that test runs are scoped to affected packages rather than running everything on every change.

### CI Pipeline Structure

```yaml
name: Test Suite
on: [push, pull_request]

jobs:
  smoke:
    name: Smoke Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm turbo run test:smoke

  unit:
    name: Unit Tests
    needs: smoke  # Only run if smoke passes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm turbo run test:unit

  integration:
    name: Integration Tests
    needs: smoke
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
      redis:
        image: redis:7
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm turbo run test:int
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/test
          REDIS_URL: redis://localhost:6379
```

## Local Development

### Running Tests Locally

```bash
# Run all tests in all packages
pnpm turbo run test

# Run tests in a specific package
cd packages/api-core && pnpm test

# Run tests in watch mode (development)
pnpm test:watch

# Run only unit tests (fast feedback)
pnpm test:unit

# Run integration tests (requires services)
docker compose up -d postgres redis
pnpm test:int
```

### Docker-Based Local Testing

For consistency with CI, support Docker-based test execution:

```yaml
# docker-compose.test.yml
version: '3.8'
services:
  test:
    build:
      context: .
      dockerfile: Dockerfile.test
    depends_on:
      - postgres
      - redis
    environment:
      DATABASE_URL: postgresql://test:test@postgres:5432/test
      REDIS_URL: redis://redis:6379
    command: pnpm turbo run test

  postgres:
    image: postgres:15
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: test

  redis:
    image: redis:7
```

```bash
# Run tests in Docker (matches CI exactly)
docker compose -f docker-compose.test.yml run test
```

## Test Reporting

### Goals

- **Machine-readable output**: CI tools can parse results and display them usefully
- **Consistent across tools**: Similar reporting from vitest, Playwright, Storybook
- **Visible results**: Test failures are easy to find and understand

### Vitest Reporters

Vitest supports multiple reporter formats. The exact choice depends on what our CI tooling can consume:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    reporters: ['default', 'json'],  // JSON is widely supported
    outputFile: {
      json: './test-results/results.json',
    },
  },
});
```

Other options include `junit` (XML format, widely supported by CI tools), `html` (for human viewing), and various community reporters. We'll standardize on specific reporters as we finalize our CI pipeline.

**Note**: Some standardized formats (like CTRF) have limited vitest support via community plugins. Evaluate reporter quality before adopting.

### Coverage Reporting

Coverage reports help track test coverage trends. Options include:
- **Codecov**: Cloud service with GitHub integration
- **Coveralls**: Similar cloud service
- **HTML reports**: Generated locally or as CI artifacts

```yaml
# Example: Codecov (one option, not prescriptive)
- name: Upload coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/coverage-final.json
```

The specific coverage service and workflow will be determined as we finalize CI setup.

### PR Comments and Test Reports

Posting test results to PRs improves visibility. Options include:
- GitHub's built-in test reporting (for supported formats)
- Third-party actions like `dorny/test-reporter`, `mikepenz/action-junit-report`
- Custom scripts that post comments

We'll evaluate which approach works best with our chosen reporter format.

## Handling Test Failures

### Flaky Test Policy

Flaky tests erode confidence. Our policy:

1. **Identify**: Tests that fail intermittently are flagged
2. **Fix or Remove**: Either fix the root cause or delete the test
3. **Skip with tracking**: If a flaky test represents important acceptance criteria that must be restored, skip it and create a GitHub issue

```typescript
// Skip a flaky acceptance test with issue tracking
describe.skip('Flaky: Race condition in websocket handler', () => {
  // TODO: https://github.com/org/repo/issues/123
  // This acceptance test must be fixed—see issue for details
  it('handles concurrent connections', () => { ... });
});
```

**Rules**:
- Flaky regression tests should generally just be removed (they're disposable)
- Flaky acceptance tests should be skipped with a GitHub issue, since they represent agreed requirements
- Skipped tests without issue references will be flagged in review
- Don't let skipped tests accumulate—they represent broken acceptance criteria

### Retry Strategy

For genuinely non-deterministic tests(network, timing) that we have no alternative testing strategy for, use controlled retries:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    retry: 2, // Retry failed tests up to 2 times
    // Only in CI:
    ...(process.env.CI && {
      retry: 2,
    }),
  },
});
```

**Caution**: Retries mask real problems. Use sparingly and track retry frequency.

### Test Timeout Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    testTimeout: 10000,     // 10s per test (unit)
    hookTimeout: 30000,     // 30s for setup/teardown (integration)
  },
});
```

## Merge Protection

### Required Checks

Configure branch protection to require each testing check to pass.

## Performance Optimization

May include:
- Caching dependencies
- Parallelizing tests (by package or type)

## Environment Parity

Ensure:
- CI node version is consistent with local (Dockerized builds for local tests avoids some drift here and in other unwanted environment issues).
- Environment variables are similar (sensitive credentials may be in GitHub secrets and vega credentials - non-sensitive can be in some shared env file in the repo).

### Consistent Node Versions

```yaml
# .nvmrc
20.10.0
```

```yaml
# CI
- uses: actions/setup-node@v4
  with:
    node-version-file: '.nvmrc'
```

### Environment Variables

```yaml
# Define test environment variables
env:
  NODE_ENV: test
  LOG_LEVEL: error
  DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
```

For sensitive values, use GitHub Secrets. For non-sensitive test configuration, use `.env.test` committed to the repo.
- e.g. ensure CI and local use same db schemas.

## Monitoring Test Health

### Track Metrics

- **Test count over time**: Dramatic cuts to tests (or new code coming in without equivalent tests) may be a warning sign
- **Test duration**: Identify slow tests
- **Flaky test rate**: Should trend toward zero
- **Coverage trends**: Maintain or improve

### Test Timing Reports

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    reporters: ['default', 'json'],
    outputFile: {
      json: './test-results/results.json',
    },
  },
});
```

Post-process to identify slow tests:

```bash
# In CI
jq '.testResults[] | select(.duration > 5000) | .name' test-results/results.json
```

## E2E Testing in CI

For Playwright E2E tests:

```yaml
e2e:
  name: E2E Tests
  needs: [unit, integration]  # Run last
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: pnpm install
    - run: npx playwright install --with-deps
    
    - name: Start Application
      run: |
        pnpm build
        pnpm start &
        npx wait-on http://localhost:3000
    
    - name: Run E2E Tests
      run: pnpm test:e2e
    
    - uses: actions/upload-artifact@v3
      if: failure()
      with:
        name: playwright-report
        path: playwright-report/
```

## Related Documents

- [Testing Philosophy](./01-testing-philosophy.md) - Why we test
- [Test Conventions](./02-test-conventions.md) - How to write tests
- [Builders and Scenarios](./03-builders-and-scenarios.md) - Test data
- [AI Agent Testing Guide](./05-ai-agent-testing-guide.md) - Guidance for AI development
