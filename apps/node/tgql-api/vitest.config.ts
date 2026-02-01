import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.unit.test.ts', 'src/__tests__/**/*.int.test.ts'],
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/test/**', '**/__tests__/**'],
      include: ['src/**/*.ts'],
    },
  },
});
