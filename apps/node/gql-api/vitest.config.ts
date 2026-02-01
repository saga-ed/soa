import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.d.ts',
                'src/**/*.test.ts',
                'src/**/*.spec.ts',
                'src/main.ts', // Exclude bootstrap file
            ],
            thresholds: {
                lines: 40,
                functions: 40,
                branches: 40,
                statements: 40,
            },
        },
        pool: 'forks',
        poolOptions: {
            forks: { singleFork: false },
        },
    },
});
