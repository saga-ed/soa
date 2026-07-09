/**
 * saga-dash adapter — baseUrl + a storageState, in one of two lanes:
 *
 * STACK lane (default) — local synthetic-dev stack. `ss stack login --output-json`
 * mints a headless session against iam-api and writes the captured cookies
 * (iam_session JWT + iam_refresh) as a Netscape cookie jar at `<stateDir>/cookies.txt`
 * (saga-stack-cli's `packages/node/saga-stack-cli/src/runtime/login.ts`). This adapter
 * shells out to that command, parses its jar, and converts it into the Playwright
 * `storageState` shape record.mjs hands to `browser.newContext()`.
 *
 * Run `ss stack up --with dash` and `ss stack login` yourself before recording — this
 * adapter mints a fresh jar on every call (session cookies decay if iam restarts; don't
 * try to cache one across runs).
 *
 * SANDBOX lane (WALKTHROUGH_LANE=sandbox) — a deployed switchboard composition on
 * wootdev.com. No local stack. Mints a session via the real `auth.login` (devLogin is
 * forbidden on deployed iam-api), passes the employee Janus perimeter via a
 * JANUS_SESSION cookie, and pins backend service routing via `x-saga-preview-*`
 * cookies — the same mechanism (and cookie names/domain) the saga-dash sandbox e2e
 * lane uses (apps/web/dash/e2e/fixtures/global-setup.ts:sandboxExtraCookies() +
 * lane.ts:mintSessionSetCookiesUncached()), reimplemented here since this tool lives in
 * a separate repo and can't import saga-dash's fixtures directly. See
 * specs/contracts/drafts/sandbox-preview-header-propagation.spec.md (saga-dash) for
 * why this must be cookies, not headers: dash-runtime reads `x-saga-preview-*` off
 * `document.cookie` and re-attaches them as headers on its own XHRs.
 *
 * Env (sandbox lane): WALKTHROUGH_DASH_URL (deployed dash origin, e.g.
 * https://dash.wootdev.com), WALKTHROUGH_IAM_URL (deployed iam-api origin, e.g.
 * https://iam.wootdev.com — used both to mint the session and to derive the apex
 * cookie domain), JANUS_SESSION (janus_session cookie value from an interactive
 * JumpCloud gate login — required unless the composition was deployed Janus-off),
 * WALKTHROUGH_PREVIEW_PINS ("svc=variant,svc=variant" — same format as saga-dash's
 * PLAYWRIGHT_PREVIEW_PINS), WALKTHROUGH_SEED_PASSWORD (defaults to 'password123',
 * matching the e2e harness's seeded-persona convention).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const LANE = process.env.WALKTHROUGH_LANE === 'sandbox' ? 'sandbox' : 'stack';

const BASE_URL =
  process.env.WALKTHROUGH_DASH_URL ?? (LANE === 'sandbox' ? 'https://dash.wootdev.com' : 'http://localhost:8900');
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
async function getStackStorageState() {
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

// ── Sandbox lane ────────────────────────────────────────────────────────────

const IAM_URL = process.env.WALKTHROUGH_IAM_URL ?? 'https://iam.wootdev.com';
const SEED_PASSWORD = process.env.WALKTHROUGH_SEED_PASSWORD ?? 'password123';
const JANUS_SESSION = process.env.JANUS_SESSION ?? '';

/** Apex of IAM_URL's host (e.g. "iam.wootdev.com" → ".wootdev.com") — mirrors
 * saga-dash e2e's lane.ts:cookieApexDomain(). */
function cookieApexDomain() {
  const host = new URL(IAM_URL).hostname;
  if (host === 'localhost' || /^[\d.]+$/.test(host)) return host;
  const parts = host.split('.');
  return parts.length > 2 ? `.${parts.slice(-2).join('.')}` : `.${host}`;
}

/** Parse WALKTHROUGH_PREVIEW_PINS ("svc=variant,svc=variant") into a map — same
 * format as saga-dash e2e's PLAYWRIGHT_PREVIEW_PINS. */
function previewPins() {
  const pins = {};
  for (const pair of (process.env.WALKTHROUGH_PREVIEW_PINS ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    pins[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return pins;
}

/**
 * Parse one Set-Cookie response header line into a Playwright cookie object.
 * Prefers the cookie's own Domain= attribute (iam-api sets it to the apex
 * domain in sandbox) over recomputing one.
 */
function parseSetCookie(line) {
  const [pair, ...attrs] = line.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  if (eq < 0) return null;
  const lower = attrs.map((a) => a.toLowerCase());
  const domainAttr = attrs.find((a) => a.toLowerCase().startsWith('domain='));
  const pathAttr = attrs.find((a) => a.toLowerCase().startsWith('path='));
  const sameSiteAttr = attrs.find((a) => a.toLowerCase().startsWith('samesite='));
  const sameSite = (sameSiteAttr?.split('=')[1] ?? 'Lax').toLowerCase();

  return {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    domain: domainAttr ? domainAttr.slice('domain='.length) : new URL(IAM_URL).hostname,
    path: pathAttr ? pathAttr.slice('path='.length) : '/',
    expires: -1,
    httpOnly: lower.includes('httponly'),
    secure: lower.includes('secure'),
    sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax',
  };
}

/**
 * Real auth.login (not devLogin, which is forbidden on deployed iam-api). Returns
 * every Set-Cookie line from the response (iam_session, iam_csrf, possibly more) —
 * caller must not filter these down before assembling storageState.
 *
 * Must attach janus_session as a Cookie header explicitly — unlike a Playwright
 * browser context, a bare Node fetch() has no cookie jar to carry it automatically,
 * and auth.login is behind the employee Janus perimeter (401 {"realms":["janus"]}
 * without it).
 */
async function mintSandboxSessionSetCookies(email) {
  if (!JANUS_SESSION) {
    throw new Error('mintSandboxSessionSetCookies called without JANUS_SESSION set');
  }
  const res = await fetch(`${IAM_URL}/trpc/auth.login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: DASH_ORIGIN,
      Cookie: `janus_session=${JANUS_SESSION}`,
    },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`auth.login ${email} → HTTP ${res.status} ${res.statusText} — ${body}`);
  }
  const raw = res.headers.getSetCookie?.() ?? [];
  if (!raw.some((c) => c.startsWith('iam_session='))) {
    throw new Error(`auth.login ${email} returned no iam_session cookie — check WALKTHROUGH_SEED_PASSWORD`);
  }
  return raw;
}

/**
 * Preview-pin + Janus cookies for the sandbox lane's browser context. Preview
 * cookies MUST be httpOnly:false — dash-runtime's preview-cookies.ts reads them off
 * document.cookie and re-attaches them as x-saga-preview-<svc> headers on its own
 * XHRs. The Janus cookie is the opposite (httpOnly:true) — the split is per-purpose,
 * not per-service.
 */
function sandboxExtraCookies() {
  const domain = cookieApexDomain();
  const extras = [];

  if (JANUS_SESSION) {
    extras.push({
      name: 'janus_session',
      value: JANUS_SESSION,
      domain,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  }

  for (const [svc, variant] of Object.entries(previewPins())) {
    extras.push({
      name: `x-saga-preview-${svc}`,
      value: variant,
      domain,
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
  }

  return extras;
}

/**
 * Mint a sandbox session via real auth.login, add Janus + preview-pin cookies, and
 * return a Playwright storageState object ({cookies, origins: []}).
 *
 * Requires JANUS_SESSION (from an interactive JumpCloud gate login) unless the
 * composition was deployed with the employee Janus perimeter off — this adapter
 * doesn't know which, so it fails loudly rather than silently recording an
 * unauthenticated/gated session if JANUS_SESSION is missing.
 */
async function getSandboxStorageState() {
  if (!JANUS_SESSION) {
    throw new Error(
      'WALKTHROUGH_LANE=sandbox needs JANUS_SESSION (janus_session cookie from an ' +
        'interactive JumpCloud gate login — copy the value from devtools). If the ' +
        'target composition was deployed with the employee Janus perimeter off, this ' +
        "adapter doesn't yet support that — set JANUS_SESSION anyway or extend this check.",
    );
  }

  const email = process.env.WALKTHROUGH_LOGIN_EMAIL ?? 'empty@saga.org';
  const raw = await mintSandboxSessionSetCookies(email);
  const cookies = raw.map(parseSetCookie).filter((c) => c !== null);
  cookies.push(...sandboxExtraCookies());

  return { cookies, origins: [] };
}

async function getStorageState() {
  return LANE === 'sandbox' ? getSandboxStorageState() : getStackStorageState();
}

export default {
  baseUrl: BASE_URL,
  origin: DASH_ORIGIN,
  getStorageState,
};
