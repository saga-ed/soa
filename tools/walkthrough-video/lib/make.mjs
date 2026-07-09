#!/usr/bin/env node
/**
 * make.mjs — one-shot orchestrator: narrate → record → stitch for a given walkthrough.
 *
 *   node lib/make.mjs --walkthrough saga-dash/entity-pages
 *   SKIP_NARRATE=1 node lib/make.mjs --walkthrough saga-dash/entity-pages   # iterate on actions/timing
 *   SKIP_RECORD=1  node lib/make.mjs --walkthrough saga-dash/entity-pages  # iterate on stitch/SRT
 *
 * Does NOT bring the stack up/down itself — run `ss stack up --with dash` (and
 * `ss stack login`) first. See README.md for the full recipe.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrateAll } from './narrate.mjs';
import { record } from './record.mjs';
import { stitch } from './stitch.mjs';
import { loadScript } from './script.mjs';

const TOOL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const args = { walkthrough: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--walkthrough') {
      args.walkthrough = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const { walkthrough } = parseArgs(process.argv.slice(2));
  if (!walkthrough || !walkthrough.includes('/')) {
    console.error('Usage: node lib/make.mjs --walkthrough <app>/<feature>');
    console.error('Example: node lib/make.mjs --walkthrough saga-dash/entity-pages');
    process.exit(1);
  }

  const [app, feature] = walkthrough.split('/');
  const walkthroughDir = path.join(TOOL_ROOT, 'walkthroughs', app, feature);
  const outDir = walkthroughDir;

  const { STEPS: jsSteps } = await import(path.join(walkthroughDir, 'steps.mjs'));
  const { default: adapter } = await import(path.join(TOOL_ROOT, 'adapters', `${app}.mjs`));

  const scriptPath = path.join(walkthroughDir, 'script.md');
  const STEPS = await loadScript(scriptPath, jsSteps);

  if (process.env.SKIP_NARRATE !== '1') {
    console.log(`[narrate] ${STEPS.length} steps…`);
    await narrateAll(STEPS, outDir);
  } else {
    console.log('[narrate] skipped (SKIP_NARRATE=1)');
  }

  if (process.env.SKIP_RECORD !== '1') {
    console.log(`[record] driving ${adapter.baseUrl}…`);
    await record(STEPS, adapter, outDir);
  } else {
    console.log('[record] skipped (SKIP_RECORD=1)');
  }

  console.log('[stitch] muxing + generating SRT…');
  const { mp4Path, vp9Path, srtPath } = await stitch(STEPS, outDir);

  console.log('\nDone:');
  console.log(`  ${mp4Path}`);
  console.log(`  ${vp9Path}`);
  console.log(`  ${srtPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
