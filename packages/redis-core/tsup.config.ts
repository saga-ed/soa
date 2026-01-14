import { defineConfig } from 'tsup';

export default defineConfig({
    entry: [
        'src/*.ts',
    ],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    splitting: false,
    skipNodeModulesBundle: true,
    target: 'node16',
});
