/**
 * `stack login` NATIVE headless-cookie-jar integration tests (M11 ITEM B).
 *
 * Drives the REAL StackLogin command end-to-end but REPLACES its seams on the
 * BaseCommand prototype:
 *   - `getCookiePoster` — a fake POST recording url/origin/body + returning canned Set-Cookies.
 *   - `getJarWriter`    — captures the jar path + bytes (no fs).
 *   - `getRunner`       — the up.sh ScriptPlan seam; asserted NOT called natively, IS called for --browser.
 *
 * Contract: native login builds the origin-checked devLogin POST at the slot-aware iam URL
 * (+ LOGIN_IAM_URL override), writes the Netscape jar to <stateDir>/cookies.txt, keeps the
 * browser half a `--browser` feature flag, surfaces the login-after-seed hint on 401 (no
 * crash), and --browser routes the full flow to up.sh --login.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { CookiePoster, JarWriter, PostOptions, PostResult } from '../../../runtime/index.js';
import type { RunResult, ScriptInvocation } from '../../../runtime/index.js';
import StackLogin from '../login.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

let config: Config;
let posts: { url: string; opts: PostOptions }[];
let jarWrites: { path: string; contents: string }[];
let runnerCalls: ScriptInvocation[];
let logged: string[];

function installPoster(result: PostResult): void {
  posts = [];
  const poster: CookiePoster = {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      posts.push({ url, opts });
      return result;
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getCookiePoster: () => unknown }, 'getCookiePoster').mockReturnValue(
    poster,
  );
}

function installJar(): void {
  jarWrites = [];
  const jar: JarWriter = { write: (path, contents) => jarWrites.push({ path, contents }) };
  vi.spyOn(BaseCommand.prototype as unknown as { getJarWriter: () => unknown }, 'getJarWriter').mockReturnValue(jar);
}

function installRunner(code = 0): void {
  runnerCalls = [];
  vi.spyOn(BaseCommand.prototype as unknown as { getRunner: () => unknown }, 'getRunner').mockReturnValue({
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runnerCalls.push(spec);
      return { code };
    },
  });
}

const OK_COOKIES: PostResult = {
  status: 200,
  ok: true,
  setCookies: ['iam_session=jwt.tok.sig; Path=/; HttpOnly', 'iam_refresh=refr; Path=/; HttpOnly'],
};

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  logged = [];
  delete process.env.LOGIN_IAM_URL;
  vi.spyOn(BaseCommand.prototype as unknown as { log: (m?: string) => void }, 'log').mockImplementation(
    (m?: string) => {
      logged.push(m ?? '');
    },
  );
  installRunner(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOGIN_IAM_URL;
});

const out = (): string => logged.join('\n');

describe('stack login — native headless cookie jar', () => {
  it('default persona: origin-checked devLogin POST at :3010 → Netscape jar at state dir (no up.sh)', async () => {
    installPoster(OK_COOKIES);
    installJar();

    await StackLogin.run([...WS], config);

    // native: up.sh Runner NEVER called.
    expect(runnerCalls).toHaveLength(0);
    // origin-checked POST at the slot-0 iam URL, default persona.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('http://localhost:3010/trpc/auth.devLogin');
    expect(posts[0]?.opts.origin).toBe('http://localhost:3010');
    expect(posts[0]?.opts.body).toBe('{"email":"dev@saga.org"}');
    // jar written to <stateDir>/cookies.txt with the captured cookies.
    expect(jarWrites).toHaveLength(1);
    expect(jarWrites[0]?.path).toBe('/tmp/sds-synthetic/cookies.txt');
    expect(jarWrites[0]?.contents).toContain('iam_session\tjwt.tok.sig');
    expect(jarWrites[0]?.contents).toContain('iam_refresh\trefr');
    // headful browser flow is surfaced as the --browser feature flag.
    expect(out()).toContain('--browser');
  });

  it('an email arg overrides the persona', async () => {
    installPoster(OK_COOKIES);
    installJar();
    await StackLogin.run(['teacher@saga.org', ...WS], config);
    expect(posts[0]?.opts.body).toBe('{"email":"teacher@saga.org"}');
  });

  it('LOGIN_IAM_URL (tunnel) overrides the localhost iam URL + Origin', async () => {
    process.env.LOGIN_IAM_URL = 'https://iam.moniker.wootdev.com';
    installPoster(OK_COOKIES);
    installJar();

    await StackLogin.run([...WS], config);

    expect(posts[0]?.url).toBe('https://iam.moniker.wootdev.com/trpc/auth.devLogin');
    expect(posts[0]?.opts.origin).toBe('https://iam.moniker.wootdev.com');
  });

  it('a 401 surfaces the login-after-seed hint (no crash) and TRUNCATES the jar (no stale session); exits 1', async () => {
    installPoster({ status: 401, ok: false, setCookies: [] });
    installJar();

    await expect(StackLogin.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 1 } });

    expect(runnerCalls).toHaveLength(0);
    // D1: a failed login truncates the jar to an empty Netscape header (no stale iam_session).
    expect(jarWrites).toHaveLength(1);
    expect(jarWrites[0]?.contents ?? jarWrites[0]).not.toContain?.('iam_session');
    const text = out();
    expect(text).toContain('HTTP 401');
    expect(text).toContain('only exists after a roster seed');
    expect(text).toContain('--browser'); // headful browser flow surfaced as the feature flag
  });

  it('--browser routes the FULL flow (jar + headful Chromium) to up.sh --login', async () => {
    installPoster(OK_COOKIES); // present but must NOT be used
    installJar();

    await StackLogin.run(['--browser', 'teacher@saga.org', ...WS], config);

    // the up.sh Runner WAS called; the native poster/jar were NOT.
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]?.args).toEqual(['--login', 'teacher@saga.org']);
    expect(posts ?? []).toHaveLength(0);
    expect(jarWrites).toHaveLength(0);
  });
});
