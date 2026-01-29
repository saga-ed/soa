import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mocks/mock-mongo-provider.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  splitting: false,
  skipNodeModulesBundle: true,
  target: 'node22',
});
