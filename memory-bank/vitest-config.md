# Vitest Configuration Pattern

This project intentionally avoids a common root-level `vitest.config.ts`.

Instead, each subproject (e.g., `db`, `config`, `core-api`, `logger`, `rest-api`) has its own standalone `vitest.config.ts` following a consistent pattern:

- Local test globs (e.g., `src/__tests__/**/*.test.ts`)
- Standardized environment and coverage settings

**Benefits:**

- Enables running all tests from the project root (using `pnpm -r test` or similar)
- Enables running only a subset of tests from within an individual subproject directory
- Improves test isolation and developer experience
- Avoids glob resolution issues in monorepos

Follow the pattern in the `db`, `core-api`, etc. packages for new subprojects.
