import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/__tests__/**/*.int.test.ts'],
        // Spawning services + spinning up testcontainers takes time.
        testTimeout: 120_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
});
