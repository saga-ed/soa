import { defineConfig } from 'tsup';

export default defineConfig({
    // `uuid` is a separate entry so consumers can `import { id } from
    // '@saga-ed/soa-event-test-harness/uuid'` WITHOUT pulling in testcontainers
    // (the index entry imports @testcontainers/* for startInfra, which drags
    // native ssh2 modules into a consumer's bundle).
    entry: ['src/index.ts', 'src/uuid.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
});
