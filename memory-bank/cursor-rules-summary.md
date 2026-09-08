# Cursor Rules Summary

This file summarizes the essential rules and patterns from `.cursor/rules/` for persistent project knowledge and onboarding.

---

## 1. Core Rules (`core.mdc`)

- **Plan Mode**: All work starts in plan mode; no changes are made until the plan is approved.
- **Act Mode**: Changes are made only after explicit approval.
- **Mode Announcements**: Always announce the current mode at the start of each response.
- **TypeScript Project Reference Rule**:
  - All `tsconfig.json` files must have `"composite": false` or omit the field.
  - The `"references"` field must not be present in any `tsconfig.json`.
  - This rule must be checked and enforced on every edit or creation of a `tsconfig.json`.

## 2. Code Organization and Cleanup (`code-organization.mdc`)

- Follow the process in `memory-bank/code-cleanup-org.md` for splitting files, moving functionality, interface separation, and code cleanup.
- Always complete all phases: Planning, Implementation, Cleanup, Verification.
- Use the verification checklist from `memory-bank/code-cleanup-org.md`.
- Reference: `memory-bank/inversify.md` for interface separation specifics.

## 3. Inversify Specification Rule (`inversify.mdc`)

- Always read and apply the specifications in `memory-bank/inversify.md` for all code, design, and documentation related to dependency injection, service abstraction, and Inversify usage.

## 4. Turborepo Specification Rule (`turborepo.mdc`)

- Always read and apply the specifications in `memory-bank/turborepo.md` for all code, configuration, and documentation related to monorepo management, project structure, and Turborepo usage.

## 5. Unit Testing Specification Rule (`unit-testing.mdc`)

- Always read and apply the specification in `memory-bank/unit-testing.md` for all unit tests, test configuration, and test file naming.

## 6. Naming Conventions Rule (`naming-conventions.mdc`)

- Always read and apply the specification in `memory-bank/naming-conventions.md` for all code, file, and documentation naming.
- This includes: file naming, class/method naming, variable/constant naming, generic type parameters, decorator naming, environment variable naming, and error type naming.
- If unsure, refer to `memory-bank/01.naming-conventions.md`.

## 7. Memory Bank Documentation (`memory-bank.mdc`)

- The Memory Bank is the single source of truth for project context, rules, and patterns.
- Structure: `projectbrief.md`, `productContext.md`, `activeContext.md`, `systemPatterns.md`, `techContext.md`, `progress.md`.
- Additional context files are encouraged for complex features, integrations, APIs, testing, and deployment.
- Workflows for Plan Mode and Act Mode are defined, including when and how to update the Memory Bank.
- `.cursor/rules` is a learning journal for project intelligence, capturing patterns, preferences, and decisions.

## Monorepo Consistency Check Rule

- The `check` command must be run at key event points (e.g., before PR, after major refactor, before release).
- The `check` command performs:
  1. A full, no-cache, forced build of the entire monorepo from the root using TurboRepo:
     `turbo run build --no-cache --force`
  2. A run of all unit tests in all packages and apps:
     `pnpm test`
- The process must halt and report if any build or test fails.
- The command can be triggered by the user at any time by requesting "check".
