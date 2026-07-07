/**
 * `core/login` + `core/cookie-jar` PURE unit tests (M11).
 *
 * The devLogin request contract (slot-aware URL + `LOGIN_IAM_URL` override + the exact
 * Origin header), the persona/ordering hint, and the Netscape jar format — all asserted
 * with zero network/fs.
 */

import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_LOGIN_USER,
  DEFAULT_LOGIN_USER,
  DEVLOGIN_PATH,
  buildDevLoginRequest,
  loginFailureHint,
  resolveIamUrl,
} from '../login.js';
import { parseSetCookie, toNetscapeJar } from '../cookie-jar.js';

describe('resolveIamUrl — slot-aware + LOGIN_IAM_URL override', () => {
  it('slot 0 ⇒ localhost:3010 (up.sh IAM_URL)', () => {
    expect(resolveIamUrl()).toBe('http://localhost:3010');
    expect(resolveIamUrl({ slot: 0 })).toBe('http://localhost:3010');
  });

  it('slot N ⇒ base + N*1000 (offset iam port)', () => {
    expect(resolveIamUrl({ slot: 1 })).toBe('http://localhost:4010');
    expect(resolveIamUrl({ slot: 3 })).toBe('http://localhost:6010');
  });

  it('LOGIN_IAM_URL (tunnel) WINS over the slot URL', () => {
    expect(resolveIamUrl({ slot: 2, loginIamUrl: 'https://iam.moniker.wootdev.com' })).toBe(
      'https://iam.moniker.wootdev.com',
    );
  });

  it('an empty LOGIN_IAM_URL falls back to the slot URL (not the empty string)', () => {
    expect(resolveIamUrl({ slot: 0, loginIamUrl: '' })).toBe('http://localhost:3010');
    expect(resolveIamUrl({ slot: 0, loginIamUrl: '   ' })).toBe('http://localhost:3010');
  });
});

describe('buildDevLoginRequest — origin-checked devLogin POST', () => {
  it('POSTs iam devLogin with the JSON body and Origin == iam URL (exactly)', () => {
    const iamUrl = 'http://localhost:3010';
    const req = buildDevLoginRequest('teacher@saga.org', iamUrl);
    expect(req.url).toBe(`${iamUrl}${DEVLOGIN_PATH}`);
    expect(req.url).toBe('http://localhost:3010/trpc/auth.devLogin');
    // Origin is iam's OWN origin — a wrong value is rejected by iam's origin-check.
    expect(req.origin).toBe(iamUrl);
    expect(req.body).toBe('{"identifier":"teacher@saga.org","email":"teacher@saga.org"}');
    expect(req.email).toBe('teacher@saga.org');
  });

  it('carries the tunnel origin when the iam URL is public', () => {
    const req = buildDevLoginRequest('dev@saga.org', 'https://iam.moniker.wootdev.com');
    expect(req.origin).toBe('https://iam.moniker.wootdev.com');
    expect(req.url).toBe('https://iam.moniker.wootdev.com/trpc/auth.devLogin');
  });
});

describe('loginFailureHint — login-after-seed / persona hint (no crash)', () => {
  it('default persona 401 ⇒ roster-seed + bootstrap-user hint', () => {
    const lines = loginFailureHint(DEFAULT_LOGIN_USER, 401);
    expect(lines[0]).toContain('HTTP 401');
    expect(lines[0]).toContain(DEFAULT_LOGIN_USER);
    expect(lines.join('\n')).toContain('only exists after a roster seed');
    expect(lines.join('\n')).toContain('--seed roster');
    // points at the bare-reset bootstrap persona
    expect(lines.join('\n')).toContain(BOOTSTRAP_LOGIN_USER);
  });

  it('a non-default persona 401 ⇒ "is it in the seeded roster?" hint', () => {
    const lines = loginFailureHint('teacher@saga.org', 401);
    expect(lines.join('\n')).toContain("is 'teacher@saga.org' present in the seeded roster");
    expect(lines.join('\n')).not.toContain('roster seed'); // uses the generic hint
  });

  it('surfaces the exact status (e.g. 403 when AUTH_ENABLED)', () => {
    expect(loginFailureHint('teacher@saga.org', 403)[0]).toContain('HTTP 403');
  });
});

describe('cookie-jar — Set-Cookie parse + Netscape serialize', () => {
  it('captures iam_session/iam_refresh (HttpOnly) into a Netscape jar', () => {
    const host = 'localhost';
    const cookies = [
      parseSetCookie('iam_session=eyJ.JWT.sig; Path=/; HttpOnly; SameSite=Lax', host),
      parseSetCookie('iam_refresh=r3fr35h; Path=/; HttpOnly', host),
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    expect(cookies.map((c) => c.name)).toEqual(['iam_session', 'iam_refresh']);

    const jar = toNetscapeJar(cookies);
    expect(jar.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    // HttpOnly cookies carry curl's #HttpOnly_ prefix; host-only ⇒ FALSE flag; value present.
    expect(jar).toContain('#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\tiam_session\teyJ.JWT.sig');
    expect(jar).toContain('#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\tiam_refresh\tr3fr35h');
  });

  it('a Domain-scoped secure cookie ⇒ leading-dot domain + TRUE flags', () => {
    const c = parseSetCookie('iam_session=v; Domain=wootdev.com; Path=/; Secure; HttpOnly', 'iam.wootdev.com');
    expect(c).not.toBeNull();
    const jar = toNetscapeJar([c as NonNullable<typeof c>]);
    // Domain= ⇒ includeSubdomains TRUE + leading dot; Secure ⇒ secure TRUE.
    expect(jar).toContain('#HttpOnly_.wootdev.com\tTRUE\t/\tTRUE\t0\tiam_session\tv');
  });

  it('a malformed Set-Cookie (no name=value) is dropped', () => {
    expect(parseSetCookie('; Path=/', 'localhost')).toBeNull();
    expect(parseSetCookie('   ', 'localhost')).toBeNull();
  });

  it('an empty cookie set ⇒ header-only jar (no rows)', () => {
    expect(toNetscapeJar([])).toBe(
      '# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n# This file was generated by saga-stack. Edit at your own risk.\n\n',
    );
  });
});
