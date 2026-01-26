import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.unit.test.ts', 'src/__tests__/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});