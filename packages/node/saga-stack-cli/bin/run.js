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

// oclif resolves the first token as a command, so a bare `-h` at the root errors
// ("command -h not found") while `--help` works. Map a root-level `-h` to
// `--help`. A per-command `-h` (e.g. `saga-stack stack up -h`) is untouched
// because a command token comes first.
if (process.argv[2] === '-h') process.argv[2] = '--help';

import { execute } from '@oclif/core';

await execute({ dir: import.meta.url });
