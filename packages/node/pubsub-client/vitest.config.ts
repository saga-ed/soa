import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.unit.test.ts', '__tests__/**/*.int.test.ts'],
    testTimeout: 10000,
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/test/**', '**/__tests__/**/mocks/**'],
    },
  },
});
