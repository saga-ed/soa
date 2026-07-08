/**
 * saga-dash adapter — baseUrl + a storageState built from `ss stack login`'s cookie jar.
 *
 * `ss stack login --output-json` mints a headless session against iam-api and writes
 * the captured cookies (iam_session JWT + iam_refresh) as a Netscape cookie jar at
 * `<stateDir>/cookies.txt` (saga-stack-cli's `packages/node/saga-stack-cli/src/runtime/login.ts`).
 * This adapter shells out to that command, parses its jar, and converts it into the
 * Playwright `storageState` shape record.mjs hands to `browser.newContext()`.
 *
 * Run `ss stack up --with dash` and `ss stack login` yourself before recording — this
 * adapter mints a fresh jar on every call (session cookies decay if iam restarts; don't
 * try to cache one across runs).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.WALKTHROUGH_DASH_URL ?? 'http://localhost:8900';
const DASH_ORIGIN = new URL(BASE_URL).origin;

/** Parse one Netscape-jar row into a Playwright cookie object. */
function parseNetscapeLine(line) {
  if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) return null;
  const httpOnly = line.startsWith('#HttpOnly_');
  const rest = httpOnly ? line.slice('#HttpOnly_'.length) : line;
  const parts = rest.split('\t');
  if (parts.length < 7) return null;
  const [rawDomain, includeSubdomains, path, secure, expires, name, value] = parts;
  // Netscape's includeSubdomains flag maps to Playwright's leading-dot domain convention.
  const domain = includeSubdomains === 'TRUE' && !rawDomain.startsWith('.') ? `.${rawDomain}` : rawDomain;

  return {
    name,
    value,
    domain,
    path,
    // Netscape jars store 0 for session cookies; Playwright wants -1 for "session".
    expires: Number(expires) > 0 ? Number(expires) : -1,
    httpOnly,
    secure: secure === 'TRUE',
    sameSite: 'Lax',
  };
}

function parseNetscapeJar(contents) {
  return contents
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !(line.startsWith('#') && !line.startsWith('#HttpOnly_')))
    .map(parseNetscapeLine)
    .filter((c) => c !== null);
}

/**
 * Run `ss stack login`, parse the resulting cookie jar, and return a Playwright
 * storageState object ({cookies, origins: []}) ready for `browser.newContext()`.
 *
 * Defaults to `ss`'s own default persona (dev@saga.org). Override with
 * WALKTHROUGH_LOGIN_EMAIL for a walkthrough that needs a specific seeded persona
 * (e.g. an already-rostered, zero-programs org for a program-creation demo).
 */
async function getStorageState() {
  const loginArgs = ['stack', 'login', '--output-json'];
  if (process.env.WALKTHROUGH_LOGIN_EMAIL) loginArgs.splice(2, 0, process.env.WALKTHROUGH_LOGIN_EMAIL);

  const { stdout } = await execFileAsync('ss', loginArgs).catch((err) => {
    throw new Error(
      `\`ss stack login\` failed — is the stack up (\`ss stack up --with dash\`)? ` +
        `Original error: ${err.message}`,
    );
  });

  const result = JSON.parse(stdout);
  if (!result.ok) {
    throw new Error(`ss stack login reported failure (status ${result.status}) — see its output above.`);
  }

  const jarContents = await readFile(result.jarPath, 'utf8');
  const cookies = parseNetscapeJar(jarContents);

  return { cookies, origins: [] };
}

export default {
  baseUrl: BASE_URL,
  origin: DASH_ORIGIN,
  getStorageState,
};
