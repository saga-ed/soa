# Testing Documentation

This directory contains comprehensive testing guidance for the Coach, Thrive, and SOA repositories.

> **AI Agents**: Start with [05-ai-agent-testing-guide.md](./05-ai-agent-testing-guide.md) for task-based routing to the right docs.

## Quick Start

**New to testing in these repos?** Read in this order:

1. [Testing Philosophy](./01-testing-philosophy.md) - Understand *why* we test the way we do
2. [Test Conventions](./02-test-conventions.md) - Learn the *patterns* and *structure*
3. [Builders and Scenarios](./03-builders-and-scenarios.md) - Master *test data* management

**Setting up CI?** See [CI/CD Integration](./04-cicd-integration.md)

**AI assistant?** Start with [AI Agent Testing Guide](./05-ai-agent-testing-guide.md)

## Document Overview

| Document | Purpose | Status |
|----------|---------|--------|
| [00 - Overview](./00-testing-overview.md) | One-page summary, status legend | Current |
| [01 - Testing Philosophy](./01-testing-philosophy.md) | ARES framework, coverage guidance | Current |
| [02 - Test Conventions](./02-test-conventions.md) | File naming, structure, patterns | Current (conventions defined, not fully applied) |
| [03 - Builders and Scenarios](./03-builders-and-scenarios.md) | Test data generation | Planned |
| [04 - CI/CD Integration](./04-cicd-integration.md) | Pipeline configuration, workflows | Current |
| [05 - AI Agent Testing Guide](./05-ai-agent-testing-guide.md) | Task routing, DI patterns for AI | Current |

## Key Concepts Summary

### The ARES Framework

We categorize tests by **purpose**:

- **Acceptance**: Proves the system meets agreed requirements (`.spec.test.ts`)
- **Regression**: Tripwires for unexpected changes (`.test.ts`)
- **Exploration**: Manual investigation to find gaps
- **Smoke**: Verifies test infrastructure works (`.smoke.test.ts`)

### Test Types vs Purposes

**Types** describe *how* tests run (unit, integration, E2E).  
**Purposes** describe *why* we wrote them (acceptance, regression, smoke).

Any type can serve any purpose.

### Core Principles

1. **Only Specify What's Special** - Test data should express *intent*, not *exact values*
2. **Scenarios as Code** - Test setups that survive schema changes
3. **CI is Truth** - Local tests must match CI; CI results are authoritative
4. **Tests Are Documentation** - Acceptance tests are living specifications
5. **Golden Datasets for Subjective Criteria** - Expert-verified examples for AI/ML outputs *(Planned)*

## File Naming Quick Reference

### Vitest Tests
| Purpose | Pattern | Example |
|---------|---------|---------|
| Regression (default) | `*.test.ts` | `user-service.test.ts` |
| Acceptance | `*.spec.test.ts` | `user-service.spec.test.ts` |
| Integration | `*.int.test.ts` | `api.int.test.ts` |
| Smoke | `*.smoke.test.ts` | `infra.smoke.test.ts` |

### Other Tools
| Tool | Pattern | Example |
|------|---------|---------|
| Storybook | `*.stories.ts` | `Button.stories.ts` |
| Playwright | `*.spec.ts` (in `e2e/`) | `auth.spec.ts` |

## Running Tests

```bash
# All tests in all packages
pnpm turbo run test

# Specific package
cd packages/api-core && pnpm test

# By type
pnpm test:unit         # Fast, no external deps
pnpm test:int          # Requires database services
pnpm test:smoke        # Infrastructure checks

# Development mode
pnpm test:watch
```

## Tools We Use

| Tool | Purpose |
|------|---------|
| [Vitest](https://vitest.dev/) | Test runner (TypeScript/JavaScript) |
| [Storybook](https://storybook.js.org/docs) | Frontend component isolation and behavior testing |
| [Fishery](https://github.com/thoughtbot/fishery) | Test data factories/builders |
| [Supertest](https://github.com/ladjs/supertest) | HTTP assertion library |
| [Playwright](https://playwright.dev/) | E2E browser testing |

### Frontend Testing Layers *(Planned)*

| Layer | Tool | What It Tests |
|-------|------|---------------|
| Utility/Logic | Vitest | Pure functions, state logic (no DOM) |
| Component | Storybook + Vitest | Isolated component behavior, interactions, states |
| Journey | Playwright | Full user flows across pages, auth, API integration |

Storybook fills the gap between unit tests and E2E—testing components in isolation like backend services.

## Repository-Specific Notes

### SOA Repository
Focus: Library contracts and utility coverage. Each package has its own `vitest.config.ts`.

### Thrive Repository  
Focus: Processing pipelines (de-identification, QTF analysis). Integration tests require Docker services.

### Coach Repository
Focus: API contracts and user-facing behavior. Uses SOA packages as dependencies.

## Contributing to These Docs

These documents should evolve as our practices mature. When updating:

1. Keep cross-references consistent
2. Update the Quick Reference tables if adding new patterns
3. Add examples from real code when possible
4. Maintain the audience-appropriate tone for each document

## Related Resources

- SOA: `/memory-bank/testing/` - Additional testing prompts and strategies
- Thrive: `/TESTING.md` - Repo-specific test setup instructions
- Coach: `/apps/coach-api/docs/` - API-specific documentation
