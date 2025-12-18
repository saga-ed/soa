import { defineConfig, type Options } from 'tsup';

export default defineConfig((options: Options) => ({
  entry: ['src/**/*'],
  clean: true,
  format: ['esm'],
  sourcemap: true,
  ...options,
}));
