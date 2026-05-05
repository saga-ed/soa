import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    // zod and @saga-ed/soa-event-envelope are peer deps. Bundling them would
    // create a second copy at runtime; zod-to-json-schema's `instanceof` checks
    // would then silently fail and emit an empty payload schema.
    external: ['zod', '@saga-ed/soa-event-envelope'],
});
