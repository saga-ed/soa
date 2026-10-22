import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/**/*.int.test.ts'], environment: 'node', hookTimeout: 120000, testTimeout: 30000, fileParallelism: false } });
