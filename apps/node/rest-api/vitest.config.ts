import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.unit.test.ts', 'src/__tests__/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/test/**', '**/__tests__/**'],
      include: ['src/**/*.ts'],
    },
  },
});
