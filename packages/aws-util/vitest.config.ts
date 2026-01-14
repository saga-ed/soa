import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.spec.ts'],
        passWithNoTests: true,
        coverage: {
            reporter: ['text', 'html'],
            exclude: ['**/node_modules/**', '**/dist/**', '**/test/**', '**/__tests__/**/mocks/**'],
        },
    },
});
