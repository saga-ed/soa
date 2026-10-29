import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Adopters such as program-hub force Zod 3 (pnpm.overrides), so the contract must
// load and validate under Zod 3 as well as Zod 4. This run swaps `zod` for the
// `zod3` alias (npm:zod@3) everywhere the unit tests import it.
const zod3 = dirname(createRequire(import.meta.url).resolve('zod3/package.json'));

export default mergeConfig(
  base,
  defineConfig({
    resolve: { alias: [{ find: /^zod$/, replacement: zod3 }] },
    test: { server: { deps: { inline: [/@saga-ed\//] } } },
  })
);
