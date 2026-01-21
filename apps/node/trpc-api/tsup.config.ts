import { defineConfig, type Options } from 'tsup';

export default defineConfig((options: Options) => ({
  entry: ['src/main.ts', 'src/inversify.config.ts', 'src/sectors/**/*'],
  clean: true,
  format: ['esm'],
  sourcemap: true,
  // Disable DTS generation for this example app
  dts: false,
  outDir: 'dist',
  splitting: false,
  skipNodeModulesBundle: true,
  target: 'node22',
  ...options,
}));
