#!/usr/bin/env node
/**
 * Build step (soa#353): rewrite oclif.manifest.json with object keys sorted
 * deeply so a no-op build yields a no-op diff. Runs after `oclif manifest` in
 * `pnpm build`. The sort logic is the single source of truth in
 * `src/manifest-canonicalize.ts` (unit-tested); this thin wrapper only does the
 * file IO against the compiled output, so `tsc` must run before it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizeManifestJson } from '../dist/manifest-canonicalize.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', 'oclif.manifest.json');

const raw = await readFile(manifestPath, 'utf8');
const canonical = canonicalizeManifestJson(raw);
if (canonical === raw) {
  console.log('oclif.manifest.json already canonical');
} else {
  await writeFile(manifestPath, canonical);
  console.log('canonicalized oclif.manifest.json');
}
