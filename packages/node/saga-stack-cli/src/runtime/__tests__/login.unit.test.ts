/**
 * `nativeLogin` orchestrator unit tests (M11 — the headless cookie-jar half).
 *
 * Drives the POST + jar-write seams with fakes: a 200 mints + writes the Netscape jar
 * with the correct Origin; a non-200 returns ok:false WITHOUT writing (so the caller
 * surfaces the persona hint) and NEVER throws.
 */

import { describe, expect, it } from 'vitest';
import { nativeLogin } from '../login.js';
import type { JarWriter } from '../login.js';
import type { CookiePoster, PostOptions, PostResult } from '../http-post.js';

function fakePoster(result: PostResult): { poster: CookiePoster; calls: { url: string; opts: PostOptions }[] } {
  const calls: { url: string; opts: PostOptions }[] = [];
  const poster: CookiePoster = {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      calls.push({ url, opts });
      return result;
    },
  };
  return { poster, calls };
}

function fakeJar(): { jar: JarWriter; writes: { path: string; contents: string }[] } {
  const writes: { path: string; contents: string }[] = [];
  return {
    jar: { write: (path, contents) => writes.push({ path, contents }) },
    writes,
  };
}

describe('nativeLogin', () => {
  const params = { email: 'dev@saga.org', iamUrl: 'http://localhost:3010', jarPath: '/tmp/sds-synthetic/cookies.txt' };

  it('200 ⇒ POSTs devLogin with Origin==iamUrl, writes the jar, reports captured cookies', async () => {
    const { poster, calls } = fakePoster({
      status: 200,
      ok: true,
      setCookies: ['iam_session=jwt; Path=/; HttpOnly', 'iam_refresh=r; Path=/; HttpOnly'],
    });
    const { jar, writes } = fakeJar();

    const res = await nativeLogin(params, { poster, jar });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.captured).toEqual(['iam_session', 'iam_refresh']);
    // origin-checked POST at the devLogin endpoint
    expect(calls[0]?.url).toBe('http://localhost:3010/trpc/auth.devLogin');
    expect(calls[0]?.opts.origin).toBe('http://localhost:3010');
    expect(calls[0]?.opts.body).toBe('{"email":"dev@saga.org"}');
    // jar written at the state-dir path, Netscape-formatted
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/tmp/sds-synthetic/cookies.txt');
    expect(writes[0]?.contents).toContain('#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\tiam_session\tjwt');
  });

  it('401 ⇒ ok:false, NO jar written, no throw (caller surfaces the hint)', async () => {
    const { poster } = fakePoster({ status: 401, ok: false, setCookies: [] });
    const { jar, writes } = fakeJar();

    const res = await nativeLogin(params, { poster, jar });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.captured).toEqual([]);
    // D1: a failed login TRUNCATES the jar (empty Netscape header, no cookie rows) so no
    // stale iam_session survives — it must not leave an old session behind.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.contents).toContain('# Netscape HTTP Cookie File');
    expect(writes[0]?.contents).not.toContain('iam_session');
  });

  it('transport error (status 0) ⇒ ok:false, jar truncated (empty)', async () => {
    const { poster } = fakePoster({ status: 0, ok: false, setCookies: [] });
    const { jar, writes } = fakeJar();
    const res = await nativeLogin(params, { poster, jar });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(writes).toHaveLength(1); // D1: truncated to empty on any non-200
  });
});
