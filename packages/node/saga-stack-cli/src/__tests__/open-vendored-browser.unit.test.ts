/**
 * `BaseCommand.openVendoredBrowser` SPA-parameterization (gh_305, M2).
 *
 * The vendored headful browser opener was hardwired to saga-dash: it resolved
 * `SAGA_DASH`/`apps/web/dash`, gated the whole step on that dir, and fell back to
 * `:8900`. gh_305 generalizes it on an optional `ctx.spa = { repoEnvVar, appDir,
 * port }` sourced from a `spa-registry` row so a non-saga-dash concierge (e.g.
 * `develop coach` → coach-web on :8800) opens its OWN app, gated on its OWN repo.
 *
 * These tests drive the protected method directly through a tiny subclass, with
 * the Runner + repo-dir-check seams faked, and assert:
 *   - the DEFAULT (no `ctx.spa`) is byte-identical to the old saga-dash behavior
 *     (cwd/SAGA_DASH_DASH under `apps/web/dash`, DASH_URL fallback `:8900`);
 *   - a `coach-web` row drives the cwd, `SAGA_DASH_DASH`, DASH_URL port, and the
 *     clone-gate off the COACH checkout instead.
 */

import { join } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../base-command.js';
import type { WorkspaceFlags } from '../base-command.js';
import type { RunResult, Runner, ScriptInvocation } from '../runtime/index.js';

/** Minimal subclass exposing the protected opener for a direct unit call. */
class TestCmd extends BaseCommand {
  static flags = { ...BaseCommand.baseFlags };
  async run(): Promise<void> {}
  public openBrowser(
    flags: WorkspaceFlags,
    ctx: Parameters<BaseCommand['openVendoredBrowser']>[1],
  ): Promise<void> {
    return this.openVendoredBrowser(flags, ctx);
  }
}

const PKG_ROOT = process.cwd();
let config: Config;
let runs: ScriptInvocation[];
let warned: string[];

/** A Runner that records every invocation and reports success. */
function fakeRunner(): Runner {
  return {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      return { code: 0 };
    },
  };
}

/** Flags with repo pins so `resolveRepoRoot` is hermetic (no real checkout read). */
function flags(over: Partial<Record<string, string>> = {}): WorkspaceFlags {
  return {
    'saga-dash': '/fixed/dev/saga-dash',
    coach: '/fixed/dev/coach',
    dev: '/fixed/dev',
    ...over,
  } as unknown as WorkspaceFlags;
}

const CTX = { email: 'dev@saga.org', iamUrl: 'http://localhost:3010', stateDir: '/tmp/s' };

beforeAll(async () => {
  config = await Config.load(PKG_ROOT);
});

beforeEach(() => {
  runs = [];
  warned = [];
  // The repo checkout is always present in these tests unless a case overrides it.
  vi.spyOn(BaseCommand.prototype, 'getRepoDirCheck').mockReturnValue(() => true);
  vi.spyOn(BaseCommand.prototype as never, 'getRunner' as never).mockReturnValue(fakeRunner() as never);
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => {
    warned.push(String(m));
    return m;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The single browser-login.mjs invocation the fake Runner recorded. */
function browserRun(): ScriptInvocation {
  const r = runs.find((x) => x.command === 'node' && (x.args[0] ?? '').endsWith('browser-login.mjs'));
  if (!r) throw new Error(`no browser-login.mjs run recorded; runs: ${JSON.stringify(runs)}`);
  return r;
}

describe('openVendoredBrowser — default (no ctx.spa) is the saga-dash behavior', () => {
  it('resolves SAGA_DASH/apps/web/dash for cwd + SAGA_DASH_DASH, DASH_URL falls back to :8900', async () => {
    const cmd = new TestCmd([], config);
    await cmd.openBrowser(flags(), { ...CTX });

    const dashApp = join('/fixed/dev/saga-dash', 'apps', 'web', 'dash');
    const r = browserRun();
    expect(r.cwd).toBe(dashApp);
    expect(r.env?.SAGA_DASH_DASH).toBe(dashApp);
    expect(r.env?.DASH_URL).toBe('http://localhost:8900');
    expect(r.env?.LOGIN_EMAIL).toBe('dev@saga.org');
    expect(r.env?.IAM_URL).toBe('http://localhost:3010');
  });

  it('an explicit dashUrl (the --hold slot-offset URL) still wins over the port fallback', async () => {
    const cmd = new TestCmd([], config);
    await cmd.openBrowser(flags(), { ...CTX, dashUrl: 'http://localhost:9900' });
    expect(browserRun().env?.DASH_URL).toBe('http://localhost:9900');
  });
});

describe('openVendoredBrowser — ctx.spa parameterizes the opener (coach-web)', () => {
  it('drives cwd/SAGA_DASH_DASH off COACH/apps/web/coach-web and DASH_URL off port 8800', async () => {
    const cmd = new TestCmd([], config);
    await cmd.openBrowser(flags(), {
      ...CTX,
      spa: { repoEnvVar: 'COACH', appDir: 'apps/web/coach-web', port: 8800 },
    });

    const coachApp = join('/fixed/dev/coach', 'apps/web/coach-web');
    const r = browserRun();
    expect(r.cwd).toBe(coachApp);
    expect(r.env?.SAGA_DASH_DASH).toBe(coachApp);
    expect(r.env?.DASH_URL).toBe('http://localhost:8800');
  });

  it('gates the clone-check off the SPA OWN repo — an absent coach checkout warn-skips (no run)', async () => {
    // Report ONLY the coach app dir absent; saga-dash present. The gate must fire
    // on coach, proving it is no longer hardwired to saga-dash.
    vi.spyOn(BaseCommand.prototype, 'getRepoDirCheck').mockReturnValue(
      (dir: string) => !dir.includes('coach'),
    );
    const cmd = new TestCmd([], config);
    await cmd.openBrowser(flags(), {
      ...CTX,
      spa: { repoEnvVar: 'COACH', appDir: 'apps/web/coach-web', port: 8800 },
    });

    expect(runs.filter((x) => x.command === 'node')).toHaveLength(0);
    expect(warned.some((w) => w.includes('SPA app not found') && w.includes('COACH'))).toBe(true);
  });
});
