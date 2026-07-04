/**
 * Native headless-login ORCHESTRATOR (M11 — the curl half of up.sh's login_user).
 *
 * Drives the injectable `CookiePoster` (POST) + `JarWriter` (fs) seams to mint a
 * headless session: POST iam's dev-only devLogin (origin-checked), and on a 200 write
 * the captured cookies (iam_session JWT + iam_refresh) to a Netscape cookie jar at the
 * state-dir path — exactly up.sh's `curl -c "$COOKIE_JAR"` result, so curl `--cookie`
 * and Playwright `storageState` harnesses read the SAME `$STATE/cookies.txt`.
 *
 * The BROWSER half (headful Playwright auto-login) STAYS DELEGATED (plan §2.3): a native
 * process cannot inject HttpOnly cookies into a real browser, so `stack login --legacy`
 * routes the full flow to up.sh. Native login = this headless jar only.
 *
 * The request-shaping is PURE (`core/login.ts` + `core/cookie-jar.ts`); this module only
 * sequences those plans through the seams — no direct network/fs of its own.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildDevLoginRequest } from '../core/login.js';
import { parseSetCookie, toNetscapeJar } from '../core/cookie-jar.js';
import type { CookiePoster } from './http-post.js';

/** The cookie-jar filename under the state dir (up.sh `COOKIE_JAR="$STATE/cookies.txt"`). */
export const COOKIE_JAR_FILE = 'cookies.txt';

/** The injectable cookie-jar fs seam — the only place the jar file is written. */
export interface JarWriter {
  /** Write `contents` to `path`, creating the parent dir (up.sh `mkdir -p "$STATE"`). */
  write(path: string, contents: string): void;
}

/** The production jar writer — `mkdir -p` the state dir then write the Netscape jar. */
export function makeRealJarWriter(): JarWriter {
  return {
    write(path: string, contents: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, 'utf8');
    },
  };
}

/** Inputs for one native login. */
export interface NativeLoginParams {
  /** Persona email to mint a session for. */
  email: string;
  /** Resolved iam URL (slot-aware or `LOGIN_IAM_URL`). */
  iamUrl: string;
  /** Absolute cookie-jar path (`<stateDir>/cookies.txt`). */
  jarPath: string;
}

/** The seams the orchestrator drives. */
export interface NativeLoginDeps {
  poster: CookiePoster;
  jar: JarWriter;
}

/** The outcome of a native login. */
export interface NativeLoginResult {
  /** True iff devLogin returned 200 and the jar was written. */
  ok: boolean;
  /** The devLogin HTTP status (`0` on a transport error). */
  status: number;
  email: string;
  iamUrl: string;
  jarPath: string;
  /** Names of the cookies written to the jar (e.g. `['iam_session','iam_refresh']`). */
  captured: string[];
}

/** The request host used to default a cookie's domain (host-only cookies). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}

/**
 * POST devLogin → on 200 write the captured cookies as a Netscape jar. A non-200
 * (or transport error ⇒ status 0) returns `ok:false` WITHOUT writing the jar and
 * WITHOUT throwing, so the caller can surface the persona/ordering hint. Never throws.
 */
export async function nativeLogin(
  params: NativeLoginParams,
  deps: NativeLoginDeps,
): Promise<NativeLoginResult> {
  const req = buildDevLoginRequest(params.email, params.iamUrl);
  const res = await deps.poster.post(req.url, { origin: req.origin, body: req.body });

  const base = {
    status: res.status,
    email: params.email,
    iamUrl: params.iamUrl,
    jarPath: params.jarPath,
  };

  if (res.status !== 200) {
    // D1: a failed (re-)login must not leave a STALE session jar behind for a later
    // headless harness to read — up.sh's `curl -c "$COOKIE_JAR"` rewrites the jar on
    // every attempt. Truncate to an empty Netscape jar so no old iam_session survives.
    deps.jar.write(params.jarPath, toNetscapeJar([]));
    return { ok: false, ...base, captured: [] };
  }

  const host = hostOf(params.iamUrl);
  const cookies = res.setCookies
    .map((h) => parseSetCookie(h, host))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  deps.jar.write(params.jarPath, toNetscapeJar(cookies));

  return { ok: true, ...base, captured: cookies.map((c) => c.name) };
}
