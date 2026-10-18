import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/schema.ts', 'src/aws.ts', 'src/openfga.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
});
