import { defineConfig } from 'vitest/config';

/**
 * Co-located unit tests live next to the code they cover under
 * `src/**\/__tests__/*.unit.test.ts` (the redis-core/soa convention). This
 * keeps them inside the `src/**` glob that turbo already caches, so no
 * `turbo.json` edit is needed. They are excluded from the lib build via
 * `tsconfig.json`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.unit.test.ts',
      'src/**/__tests__/**/*.int.test.ts',
    ],
    coverage: {
      reporter: ['text', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
      ],
    },
  },
});
