import { defineConfig } from 'vitest/config';

// Default test run picks up ONLY hermetic tests. The cross-service tests
// in src/__tests__/*.int.test.ts are run via vitest.int.config.ts so
// `pnpm test` stays fast and doesn't require Docker.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/__tests__/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/*.int.test.ts'],
    },
});
