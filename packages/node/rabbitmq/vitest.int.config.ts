import { defineConfig } from 'vitest/config';

// Real-broker tests: `pnpm test:int` (env vars: see __tests__/consumer-options.broker.test.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.broker.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globals: true,
  },
});
