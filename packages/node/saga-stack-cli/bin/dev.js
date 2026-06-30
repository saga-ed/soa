#!/usr/bin/env -S node --import tsx/esm --disable-warning=ExperimentalWarning
/**
 * saga-stack — oclif dev entry shim.
 *
 * Runs commands straight from `src/` with no build step: the `tsx/esm`
 * loader transpiles TypeScript on the fly, and `development: true` tells
 * oclif to resolve commands from `src/commands` instead of `dist/commands`.
 * Use `bin/run.js` for the built/linked binary.
 */

// Mirror run.js: keep stdout parseable when JSON output is requested.
if (process.argv.includes('--output-json') && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'error';
}

import { execute } from '@oclif/core';

await execute({ development: true, dir: import.meta.url });
