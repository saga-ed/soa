import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    // zod stays external because it's a peer dep — adopters and the tool
    // must share one zod instance. Bundling a second copy would silently
    // break zod-to-json-schema's `instanceof ZodObject` checks and emit an
    // empty payload schema. envelope is external for hygiene — we only
    // import its types (PayloadDescriptor), so this just keeps the bundle
    // smaller.
    external: ['zod', '@saga-ed/soa-event-envelope'],
});
