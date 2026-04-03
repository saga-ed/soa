import { defineConfig } from 'tsup';

export default defineConfig({
    entry: [
        'src/index.ts',
        'src/fixture-server.ts',
        'src/abstract-fixture-controller.ts',
        'src/service-restart.ts',
        'src/admin-registration.ts',
        'src/types.ts',
    ],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    splitting: false,
    skipNodeModulesBundle: true,
    target: 'node22',
});
