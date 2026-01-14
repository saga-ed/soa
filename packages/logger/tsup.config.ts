import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mocks/mock-logger.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension: ({ format }) => ({ js: '.js' }),
  splitting: false,
  skipNodeModulesBundle: true,
});
