import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  // CLI entry needs a shebang so the compiled file is directly executable via
  // the bin field in package.json.
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  splitting: false,
  skipNodeModulesBundle: true,
  target: 'node22',
});
