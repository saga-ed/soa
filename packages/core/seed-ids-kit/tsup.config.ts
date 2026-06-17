import { defineConfig } from 'tsup';

export default defineConfig({
  // All entries are browser-safe (no node:crypto): `@noble/hashes` is isomorphic.
  entry: ['src/index.ts', 'src/uuid.ts', 'src/derivers.ts', 'src/contract.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  splitting: false,
  skipNodeModulesBundle: true,
  target: 'es2022',
});
