import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node16',
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension: ({ format }) => ({ js: '.js' }),
  splitting: false,
  skipNodeModulesBundle: true,
});
