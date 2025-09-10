import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      'zod-to-ts': path.resolve('../../node_modules/.pnpm/zod-to-ts@1.2.0_typescript@5.8.3_zod@3.25.67/node_modules/zod-to-ts/dist/index.js'),
    },
  },
});
