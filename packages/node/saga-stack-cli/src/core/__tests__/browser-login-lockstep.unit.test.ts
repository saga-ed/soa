/**
 * Lockstep pin: the vendored `browser-login.mjs` must send the same devLogin
 * payload shape as `core/login.ts` (`{ identifier, email }`, rostering#756).
 *
 * The vendored script is run as-is by `ss stack login --browser` and the
 * `e2e run --hold` autologin (resolveVendorScript — no build step), so it is
 * invisible to type-checking and to the `buildDevLoginRequest` unit pin. It
 * has silently drifted to the legacy `{ email }`-only body more than once,
 * which 400s against post-rostering#756 iam-api (AUTOLOGIN_FAIL). This test
 * reads the script's source so that drift fails CI instead of a live run.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const vendoredPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../vendor/browser-login.mjs',
);

describe('vendored browser-login.mjs — devLogin payload lockstep with core/login', () => {
  it('sends `identifier` alongside `email` (rostering#756)', () => {
    const source = readFileSync(vendoredPath, 'utf8');
    expect(source).toContain('identifier: EMAIL');
    // The legacy email-only body 400s (zod invalid_union at `identifier`).
    expect(source).not.toMatch(/data:\s*\{\s*email:\s*EMAIL\s*\}/);
  });
});
