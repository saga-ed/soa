/**
 * script.mjs — parse a walkthrough's `.md` script into per-step narration + tailSlack,
 * and merge it onto the `{id, action}` entries exported by that walkthrough's steps.mjs.
 *
 * Format (one `##` heading per step, id must match steps.mjs's step.id):
 *
 *   ## 00-intro
 *
 *   Welcome to the walkthrough. Prose can span multiple lines and
 *   paragraphs — it's joined with single spaces into one narration string.
 *
 *   tailSlack: 800
 *
 *   ## 01-name
 *
 *   Next paragraph of narration.
 *
 * `tailSlack: <ms>` is optional and, if present, must be the last line of the step's
 * body (a bare `key: value` line, not part of the narration prose). Steps with no
 * tailSlack line default to 0, matching the prior inline-JS default.
 */

import { readFile } from 'node:fs/promises';

const HEADING_RE = /^##\s+(\S+)\s*$/;
const TAIL_SLACK_RE = /^tailSlack:\s*(\d+)\s*$/i;

/**
 * Parse `.md` script text into an ordered array of `{id, narration, tailSlack}`.
 */
export function parseScript(markdown) {
  const lines = markdown.split('\n');
  const steps = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    current.narration = current.narrationLines.join(' ').replace(/\s+/g, ' ').trim();
    delete current.narrationLines;
    steps.push(current);
  };

  for (const line of lines) {
    const heading = line.match(HEADING_RE);
    if (heading) {
      flush();
      current = { id: heading[1], narrationLines: [], tailSlack: 0 };
      continue;
    }
    if (!current) continue;

    const tailSlack = line.match(TAIL_SLACK_RE);
    if (tailSlack) {
      current.tailSlack = Number.parseInt(tailSlack[1], 10);
      continue;
    }

    const trimmed = line.trim();
    if (trimmed) current.narrationLines.push(trimmed);
  }
  flush();

  return steps;
}

/**
 * Read `scriptPath` and merge its parsed `{id, narration, tailSlack}` onto the
 * `{id, action}` entries in `jsSteps` (from steps.mjs), matched by id. Throws if the
 * two lists disagree on which ids exist, so a stale script or stale steps.mjs fails
 * loudly instead of silently dropping a step.
 */
export async function loadScript(scriptPath, jsSteps) {
  const markdown = await readFile(scriptPath, 'utf8');
  const scriptSteps = parseScript(markdown);

  const scriptById = new Map(scriptSteps.map((s) => [s.id, s]));
  const jsById = new Map(jsSteps.map((s) => [s.id, s]));

  const missingFromScript = jsSteps.map((s) => s.id).filter((id) => !scriptById.has(id));
  const missingFromJs = scriptSteps.map((s) => s.id).filter((id) => !jsById.has(id));
  if (missingFromScript.length || missingFromJs.length) {
    throw new Error(
      `script.mjs: step id mismatch between ${scriptPath} and steps.mjs — ` +
        `missing from script: [${missingFromScript.join(', ')}]; ` +
        `missing from steps.mjs: [${missingFromJs.join(', ')}]`,
    );
  }

  return jsSteps.map((jsStep) => {
    const { narration, tailSlack } = scriptById.get(jsStep.id);
    return { ...jsStep, narration, tailSlack };
  });
}
