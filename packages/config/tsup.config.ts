import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/config-manager.ts',
    'src/config-validation-error.ts',
    'src/dotenv-config-manager.ts',
    'src/i-config-manager.ts',
    'src/mocks/mock-config-manager.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  splitting: false,
  skipNodeModulesBundle: true,
  target: 'node22',
});
