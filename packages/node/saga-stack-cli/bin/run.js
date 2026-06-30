#!/usr/bin/env node
/**
 * saga-stack — oclif entry shim (built output).
 *
 * Discovers commands at dist/commands/<topic>/<verb>.js (configured via the
 * oclif block in package.json: strategy=pattern, target=./dist/commands).
 */

// Suppress noisy logger output when the caller asked for JSON on stdout —
// downstream libs (if any) should not contaminate parseable output.
if (process.argv.includes('--output-json') && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'error';
}

import { execute } from '@oclif/core';

await execute({ dir: import.meta.url });
