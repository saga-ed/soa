/**
 * Native headless-login PLANNING (M11 — the curl half of up.sh's login_user, ~1935-1960).
 *
 * PURE request-building for the dev-only `iam-api` devLogin: the slot-aware iam URL
 * (+ `LOGIN_IAM_URL` tunnel override), the exact devLogin POST (endpoint + body +
 * the ORIGIN header iam demands), and the persona/ordering hint surfaced on a
 * non-200. NO IO — the actual POST + cookie-jar write live behind the runtime seams
 * (`runtime/http-post.ts` + `runtime/login.ts`); this module only shapes data so the
 * request contract is unit-tested with zero network.
 *
 * devLogin is DEV-ONLY (403s when `AUTH_ENABLED`, expected in dev) and ORIGIN-CHECKED:
 * iam only accepts a request whose `Origin` is its OWN allowlisted origin (the `/demo`
 * page's origin), so we send `Origin: <iamUrl>` — iam's own URL — verbatim. A wrong
 * origin is rejected, so this is load-bearing (see `buildDevLoginRequest`).
 */

import { SLOT_PORT_STRIDE } from './derive-instance.js';

/** up.sh `DEFAULT_LOGIN_USER` — the rostered Seed District admin, only present after a roster seed. */
export const DEFAULT_LOGIN_USER = 'dev@saga.org';

/** The bootstrap user that exists after a BARE reset (no roster) — up.sh's login-after-reset fallback. */
export const BOOTSTRAP_LOGIN_USER = 'dev@example.org';

/** iam-api's base port at slot 0 (up.sh `IAM_PORT=3010`). Slot N adds `N * SLOT_PORT_STRIDE`. */
export const IAM_BASE_PORT = 3010;

/** iam-api's dev-only devLogin tRPC endpoint (up.sh `POST $iam_url/trpc/auth.devLogin`). */
export const DEVLOGIN_PATH = '/trpc/auth.devLogin';

/** The fully-resolved devLogin POST: where, with which origin, and the JSON body. */
export interface DevLoginRequest {
  /** `<iamUrl>/trpc/auth.devLogin`. */
  url: string;
  /** The `Origin` header — iam's OWN origin (== `iamUrl`); a wrong value is rejected. */
  origin: string;
  /** `{"email":"<email>"}`. */
  body: string;
  email: string;
}

/**
 * Resolve the iam URL the login flow POSTs to:
 *   - `LOGIN_IAM_URL` (non-empty) WINS — the tunnel case, where login goes through the
 *     PUBLIC iam host (a localhost `Set-Cookie` is rejected on a domain-cookie stack).
 *   - otherwise the slot-aware localhost URL: `http://localhost:<IAM_BASE_PORT + slot*STRIDE>`
 *     (slot 0 ⇒ `:3010`, byte-identical to up.sh's `IAM_URL`).
 * Pure.
 */
export function resolveIamUrl(opts: { slot?: number; loginIamUrl?: string } = {}): string {
  if (opts.loginIamUrl !== undefined && opts.loginIamUrl.trim() !== '') {
    return opts.loginIamUrl;
  }
  const offset = (opts.slot ?? 0) * SLOT_PORT_STRIDE;
  return `http://localhost:${IAM_BASE_PORT + offset}`;
}

/**
 * Build the devLogin POST for `email` against `iamUrl`. `Origin` is set to `iamUrl`
 * itself — iam's origin-check only accepts its own allowlisted origin, so this must
 * match the iam host exactly (up.sh: `-H "Origin: $iam_url"`). Pure.
 */
export function buildDevLoginRequest(email: string, iamUrl: string): DevLoginRequest {
  return {
    url: `${iamUrl}${DEVLOGIN_PATH}`,
    origin: iamUrl,
    body: JSON.stringify({ email }),
    email,
  };
}

/**
 * The persona/ordering hint for a non-200 devLogin — a faithful port of up.sh's
 * failure branch. The default `dev@saga.org` persona 401s BEFORE a roster seed
 * exists (login-after-seed), so its hint points at seeding first (+ the bootstrap
 * `dev@example.org` for a bare reset); any other persona gets the "is it seeded?"
 * hint. Pure — the caller prints these and exits non-zero, it never crashes.
 */
export function loginFailureHint(email: string, status: number): string[] {
  const lines = [`✗ devLogin failed (HTTP ${status}) for '${email}'.`];
  if (email === DEFAULT_LOGIN_USER) {
    lines.push(
      `  '${email}' is the rostered Seed District admin — it only exists after a roster seed.`,
      '  Seed first, e.g.  saga-stack stack up --seed roster  (or `stack seed roster`), then log in.',
      `  For a bare reset (no roster), the only user is the bootstrap one: saga-stack stack login ${BOOTSTRAP_LOGIN_USER}`,
    );
  } else {
    lines.push(`  Is iam-api up and is '${email}' present in the seeded roster?`);
  }
  return lines;
}
