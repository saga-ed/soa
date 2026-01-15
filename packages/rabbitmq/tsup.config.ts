import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    // Node built-ins
    'fs',
    'path',
    'crypto',
    'os',
    'util',
    'events',
    'stream',
    'node:fs',
    'node:path',
    'node:crypto',
    'node:os',
    'node:util',
    'node:events',
    'node:stream'
  ],
  noExternal: [],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  minify: false,
  bundle: true,
  splitting: false
});

