import { defineConfig } from 'tsup';

export default defineConfig([
  // Library build (existing)
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['commander', 'zod', 'zod-to-ts'], // Keep externals for library usage
  },
  // CLI build (bundled)
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    outDir: 'dist/cli',
    clean: false,
    treeshake: true,
    bundle: true,
    minify: false,
    noExternal: ['zod', 'zod-to-ts'], // Bundle zod dependencies
    external: ['commander'], // Keep commander external as it's a CLI framework
    platform: 'node',
    target: 'node22',
    shims: true, // Add shims for __dirname, __filename etc
  },
]);
