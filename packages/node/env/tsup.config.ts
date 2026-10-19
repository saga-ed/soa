import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
    eslint: 'src/eslint/index.ts',
    aws: 'src/aws.ts',
    'ratchet-cli': 'src/eslint/ratchet-cli.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
