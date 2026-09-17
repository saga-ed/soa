import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/__tests__/**/*.int.test.ts'],
        // Talking to a real broker, including queue declaration and teardown.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        fileParallelism: false,
    },
});
