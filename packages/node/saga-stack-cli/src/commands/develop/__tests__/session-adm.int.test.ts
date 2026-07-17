/**
 * `develop session-adm` integration tests (M2, ss-develop-session-adm plan) —
 * the demo concierge driven through the REAL oclif command with every
 * BaseCommand IO seam faked (connect.int/coach.int harness). NOTHING is
 * spawned; the fake Runner/Launcher record the intended invocations.
 *
 * Coverage owned here (the axes the sibling suites don't):
 *  - the DEMO SERVICE ENV seam: the three VITE_* keys are in `process.env` at
 *    the moment saga-dash/connect-web LAUNCH (the launcher spreads process.env
 *    into fresh spawns), and the soa#346-baked ADS_ADM_* gates are NOT
 *    re-injected by the command;
 *  - the down-first contract (StackDown runs, slot-forwarded, unless --reuse);
 *  - the held-run Playwright env (DEMO_HOLD / DEMO_STAGGER_MS / FAKE_MEDIA)
 *    reaching ONLY the demo spawn, never the journey prerequisite;
 *  - the admin hand-off (jar + vendored browser at the SESSION-mode attendance
 *    dash, fired BEFORE the held spawn; --no-admin / mint-failure degradations);
 *  - the admin-browser LIFECYCLE (held-success awaits the window; --no-hold and
 *    the demo-failure path ABORT the child — never orphaned);
 *  - slot plumbing (offset state dir / iam / dash URL / slot-pinned login
 *    remediation one-liners — concrete slot-2 proofs);
 *  - the --refresh-snapshot bake path (the shared bakePrerequisiteCheckpoints
 *    helper, wired with THIS command's slot-offset deps).
 */

import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { ScriptInvocation } from '../../../runtime/index.js';
import type { CheckpointStore, CookiePoster, JarWriter, LaunchResult, LaunchSpec, PostOptions, PostResult, ServiceLauncher, StopResult } from '../../../runtime/index.js';
import { restoreEnv, saveEnv, useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import type { EnvSnapshot } from '../../../__tests__/helpers/env.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import StackDown from '../../stack/down.js';
import DevelopSessionAdm from '../session-adm.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

/** The command MUTATES process.env (the service-env seam) — snapshot + restore per test. */
const ENV_KEYS = [
  'VITE_DASH_LIVE_SESSIONS',
  'VITE_DEMO_LIVE_ATTENDANCE',
  'VITE_CONNECTV3_HEARTBEAT_INTERVAL_MS',
  'ADS_ADM_SESSION_DATA_PROVIDER',
  'ADS_ADM_MOCK_SESSION_DATA_ENABLED',
  'ADMIN_EMAIL',
  'LOGIN_IAM_URL',
  'LOGIN_DASH_URL',
] as const;

let DASH_ROOT: string;
let config: Config;
let runs: ScriptInvocation[];
let envSnapshot: EnvSnapshot;
let warns: string[];
let logs: string[];

/**
 * Per-launch sample of the demo/service env AT LAUNCH TIME. The real launcher
 * spawns with `{ ...process.env, ...launchEnv }`, so what matters is the value
 * of `process.env` at the MOMENT `launch()` is called — sampled here, not after
 * the run (a post-hoc read cannot distinguish "set before the launch" from
 * "set after", which is the whole seam).
 */
interface LaunchEnvSample {
  id: string;
  dashLive: string | undefined;
  demoLive: string | undefined;
  heartbeat: string | undefined;
  adsProvider: string | undefined;
  adsMock: string | undefined;
}
let launchSamples: LaunchEnvSample[];
let launcherStateDirs: unknown[];

useTempSnapshotsDir('saga-session-adm-');

function installSeams(opts: { playwrightFail?: string } = {}): void {
  const seams = installCoreSeams({
    pidBase: 2000,
    prepFresh: false,
    captureLauncherSpy: true,
    ...(opts.playwrightFail !== undefined ? { playwrightFail: opts.playwrightFail } : {}),
  });
  runs = seams.runs;

  // Replace the battery's launcher with an ENV-SAMPLING twin (same contract).
  launchSamples = [];
  launcherStateDirs = [];
  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      launchSamples.push({
        id: spec.id,
        dashLive: process.env.VITE_DASH_LIVE_SESSIONS,
        demoLive: process.env.VITE_DEMO_LIVE_ATTENDANCE,
        heartbeat: process.env.VITE_CONNECTV3_HEARTBEAT_INTERVAL_MS,
        adsProvider: process.env.ADS_ADM_SESSION_DATA_PROVIDER,
        adsMock: process.env.ADS_ADM_MOCK_SESSION_DATA_ENABLED,
      });
      return { id: spec.id, ok: true, pid: 4000 + launchSamples.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true }));
    },
  };
  (seams.launcherSpy as ReturnType<typeof vi.spyOn>).mockImplementation(((stateDir: unknown) => {
    launcherStateDirs.push(stateDir);
    return launcher;
  }) as never);

  // No-checkpoint store: the journey prerequisite always falls back to the
  // headless replay — hermetic, and it makes the prereq spawns observable.
  const store: CheckpointStore = { load: () => null, bake: async () => {}, restore: async () => {} };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getCheckpointStore: () => CheckpointStore },
    'getCheckpointStore',
  ).mockImplementation(() => store);
}

// Native-login seams (cookie poster + jar writer), mirroring coach.int.test.ts.
let posts: { url: string; opts: PostOptions }[];
const OK_COOKIES: PostResult = {
  status: 200,
  ok: true,
  setCookies: ['iam_session=jwt.tok.sig; Path=/; HttpOnly', 'iam_refresh=refr; Path=/; HttpOnly'],
};

function installLoginSeams(result: PostResult = OK_COOKIES): void {
  posts = [];
  const poster: CookiePoster = {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      posts.push({ url, opts });
      return result;
    },
  };
  const jar: JarWriter = { write: () => {} };
  vi.spyOn(BaseCommand.prototype as never, 'getCookiePoster' as never).mockReturnValue(poster as never);
  vi.spyOn(BaseCommand.prototype as never, 'getJarWriter' as never).mockReturnValue(jar as never);
}

/** Workspace flags: stub saga-dash (no flows.json → bundled example) + real soa. */
function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT];
}

function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

/** The held demo spawn (the flow's single stage). */
function demoRun(): ScriptInvocation | undefined {
  return playwrightRuns().find((r) => r.args.includes('connect-session-demo'));
}

/** The journey prerequisite's terminal-stage spawn (the replay's signature). */
function prereqRun(): ScriptInvocation | undefined {
  return playwrightRuns().find((r) => r.args.includes('stage-7-attendance'));
}

/** The vendored browser-login.mjs child invocation (the admin hand-off). */
function browserRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'node' && (r.args[0] ?? '').endsWith('browser-login.mjs'));
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-session-adm-'));
});
afterAll(() => {
  rmSync(DASH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  envSnapshot = saveEnv(ENV_KEYS);
  for (const k of ENV_KEYS) delete process.env[k];
  config = await Config.load(PKG_ROOT);
  installSeams();
  installLoginSeams();
  vi.spyOn(StackDown, 'run').mockResolvedValue(undefined as never);
  logs = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(((m?: string) => {
    logs.push(m ?? '');
  }) as never);
  warns = [];
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => {
    warns.push(m);
    return m;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(envSnapshot);
});

describe('develop session-adm — flag rejections', () => {
  it('--refresh-snapshot --reuse hard-errors (nothing to bake)', async () => {
    await expect(DevelopSessionAdm.run(['--refresh-snapshot', '--reuse', ...ws()], config)).rejects.toThrow(
      /--refresh-snapshot and --reuse are mutually exclusive/,
    );
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('--refresh-snapshot --no-prereq-from-snapshot hard-errors (bakes what could never restore)', async () => {
    await expect(
      DevelopSessionAdm.run(['--refresh-snapshot', '--no-prereq-from-snapshot', ...ws()], config),
    ).rejects.toThrow(/--refresh-snapshot needs --prereq-from-snapshot/);
    expect(playwrightRuns()).toHaveLength(0);
  });
});

describe('develop session-adm — the demo service-env seam', () => {
  it('the three VITE_* demo keys are in process.env when saga-dash/connect-web LAUNCH', async () => {
    await DevelopSessionAdm.run([...ws()], config);

    const sampled = launchSamples.filter((s) => s.id === 'saga-dash' || s.id === 'connect-web');
    expect(sampled.length).toBeGreaterThan(0);
    for (const s of sampled) {
      expect(s.dashLive).toBe('true');
      expect(s.demoLive).toBe('true');
      expect(s.heartbeat).toBe('3000');
    }
  });

  it('does NOT re-inject the soa#346-baked ADS_ADM_* gates (ground rule)', async () => {
    await DevelopSessionAdm.run([...ws()], config);

    // The manifest owns these now; the command shadowing them would defeat the
    // adoption-guard fingerprint. Every launch must see them UNSET in process.env.
    for (const s of launchSamples) {
      expect(s.adsProvider).toBeUndefined();
      expect(s.adsMock).toBeUndefined();
    }
  });

  it('runs `stack down` FIRST (slot-forwarded) so the demo env reaches fresh spawns', async () => {
    await DevelopSessionAdm.run([...ws()], config);

    expect(StackDown.run).toHaveBeenCalledTimes(1);
    const argv = (StackDown.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(argv.slice(0, 2)).toEqual(['--slot', '0']);
    expect(argv).toContain('--saga-dash');
  });

  it('--reuse skips the down AND the prerequisite (current-stack mode, caveat warned)', async () => {
    await DevelopSessionAdm.run(['--reuse', ...ws()], config);

    expect(StackDown.run).not.toHaveBeenCalled();
    expect(prereqRun()).toBeUndefined();
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(false);
    expect(demoRun()).toBeDefined();
    expect(warns.some((w) => /--reuse: skipping the stack down/.test(w))).toBe(true);
  });
});

describe('develop session-adm — the held demo run env', () => {
  it('defaults pin DEMO_HOLD=1 + the ADVERTISED 15s stagger onto the demo spawn ONLY', async () => {
    await DevelopSessionAdm.run([...ws()], config);

    const demo = demoRun();
    expect(demo?.env?.DEMO_HOLD).toBe('1');
    // Pinned EXPLICITLY: the spec's own fallback is 6s, the advertised cadence 15s.
    expect(demo?.env?.DEMO_STAGGER_MS).toBe('15000');

    // Flow-env overlay scoping: the journey prerequisite (a separate
    // ResolvedFlow) must NOT inherit the demo knobs — a held journey stage
    // would wedge the headless replay.
    const prereq = prereqRun();
    expect(prereq).toBeDefined();
    expect(prereq?.env?.DEMO_HOLD).toBeUndefined();
    expect(prereq?.env?.DEMO_STAGGER_MS).toBeUndefined();
  });

  it('--no-hold drops DEMO_HOLD (straight-through run); the stagger stays pinned', async () => {
    await DevelopSessionAdm.run(['--no-hold', ...ws()], config);
    expect(demoRun()?.env?.DEMO_HOLD).toBeUndefined();
    expect(demoRun()?.env?.DEMO_STAGGER_MS).toBe('15000');
  });

  it('--stagger-ms reaches the demo spawn; --fake-media still pins FAKE_MEDIA (documented no-op)', async () => {
    // FAKE_MEDIA is consumed by NOTHING in the connect-session-demo project (its
    // launchOptions hardcode synthetic media) — the flag is kept for family
    // muscle-memory only, so this pins the env plumbing, not any behavior.
    await DevelopSessionAdm.run(['--stagger-ms', '6000', '--fake-media', ...ws()], config);
    expect(demoRun()?.env?.DEMO_STAGGER_MS).toBe('6000');
    expect(demoRun()?.env?.FAKE_MEDIA).toBe('1');
  });

  it('forwards passthrough args after `--` to the demo spawn only, never the prerequisite', async () => {
    await DevelopSessionAdm.run([...ws(), '--', '--debug'], config);
    expect(demoRun()?.args.at(-1)).toBe('--debug');
    expect(prereqRun()?.args).not.toContain('--debug');
  });
});

describe('develop session-adm — the admin hand-off', () => {
  it('mints empty@saga.org and opens the SESSION-mode attendance dash BEFORE the held spawn', async () => {
    await DevelopSessionAdm.run([...ws()], config);

    // Jar minted against the base iam for the default admin persona.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('http://localhost:3010');
    expect(JSON.stringify(posts[0]?.opts)).toContain('empty@saga.org');

    const [browser] = browserRuns();
    expect(browser).toBeDefined();
    expect(browser?.env?.DASH_URL).toBe('http://localhost:8900/dashboard/attendance?mode=session');
    expect(browser?.env?.LOGIN_EMAIL).toBe('empty@saga.org');

    // ORDER: the browser child is fired before the held demo spawn owns the TTY
    // (the spec's pre-join hold is the window in which the dash must already be
    // open). Both land in the SAME recording Runner, so the order is provable.
    const browserIdx = runs.indexOf(browser as ScriptInvocation);
    const demoIdx = runs.indexOf(demoRun() as ScriptInvocation);
    expect(browserIdx).toBeGreaterThanOrEqual(0);
    expect(demoIdx).toBeGreaterThan(browserIdx);
  });

  it('--no-admin skips the jar + browser entirely; the demo still runs', async () => {
    await DevelopSessionAdm.run(['--no-admin', ...ws()], config);
    expect(posts).toHaveLength(0);
    expect(browserRuns()).toHaveLength(0);
    expect(demoRun()).toBeDefined();
  });

  it('a failed mint WARNS and skips the browser — the demo is never blocked', async () => {
    installLoginSeams({ status: 500, ok: false, setCookies: [] });
    await DevelopSessionAdm.run([...ws()], config);
    expect(browserRuns()).toHaveLength(0);
    expect(warns.some((w) => /session mint failed \(HTTP 500\)/.test(w))).toBe(true);
    expect(demoRun()).toBeDefined();
  });
});

describe('develop session-adm — the admin-browser lifecycle (never orphaned)', () => {
  it('held success AWAITS the window: the browser child is never aborted', async () => {
    await DevelopSessionAdm.run([...ws()], config);
    expect(browserRuns()[0]?.signal?.aborted).toBe(false);
  });

  it('--no-hold does NOT hold on the admin window: the child is closed after the run', async () => {
    // --no-hold is the advertised CI-ish straight-through run — awaiting a human
    // closing the window would hang it; exiting without the abort would orphan
    // the child onto the freed TTY.
    await DevelopSessionAdm.run(['--no-hold', ...ws()], config);
    expect(browserRuns()[0]?.signal?.aborted).toBe(true);
    expect(logs.some((l) => /--no-hold: closing the admin browser/.test(l))).toBe(true);
  });

  it('a failing demo run closes the browser child too, then exits with the demo code', async () => {
    // The shell-script spec killed the admin browser in its cleanup trap — the
    // failure path must not leave an orphaned Chromium presenting a zero dash.
    installSeams({ playwrightFail: 'connect-session-demo' });
    await expect(DevelopSessionAdm.run([...ws()], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
    expect(warns.some((w) => /pod-A membership guard/.test(w))).toBe(true);
    expect(browserRuns()[0]?.signal?.aborted).toBe(true);
  });
});

describe('develop session-adm — the --refresh-snapshot bake path (shared helper wired)', () => {
  it('bakes the journey prerequisite off the slot-2 stack BEFORE the demo', async () => {
    await DevelopSessionAdm.run(['--refresh-snapshot', '--slot', '2', ...ws()], config);

    // The bake is its OWN executeResolvedFlow call (a stage-by-stage headless
    // replay from stage 1) and must ride the slot's OFFSET ports — a bake driven
    // against the base iam would bake slot-0 data into the slot-2 checkpoint
    // root (the connect.int twin, pinned HERE because the wiring is this
    // command's own call into the shared bakePrerequisiteCheckpoints).
    const bake = playwrightRuns().find((r) => r.args.includes('stage-1-roster'));
    expect(bake).toBeDefined();
    expect(bake?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:5010');

    // The held demo still runs, AFTER the bake.
    const demo = demoRun();
    expect(demo).toBeDefined();
    expect(runs.indexOf(demo as ScriptInvocation)).toBeGreaterThan(runs.indexOf(bake as ScriptInvocation));
  });
});

describe('develop session-adm — slot awareness (slot > 0)', () => {
  it('--slot 2 targets slot 2 end-to-end: state dir, iam, dash URL, down argv — and warns the AV caveat', async () => {
    await DevelopSessionAdm.run(['--slot', '2', ...ws()], config);

    // Launcher pinned at the slot's state dir.
    expect(launcherStateDirs[0]).toBe('/tmp/sds-synthetic-s2');

    // The held demo drives the slot-2 OFFSET services (offset = slot * 1000)…
    expect(demoRun()?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:5010');
    // …and the prerequisite rides the same deps (the soa#300 tail).
    expect(prereqRun()?.env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:5010');

    // Admin jar + browser on the slot's OWN iam + dash.
    expect(posts[0]?.url).toContain('http://localhost:5010');
    expect(browserRuns()[0]?.env?.DASH_URL).toBe('http://localhost:10900/dashboard/attendance?mode=session');

    // The down step tears down the SLOT's services, not slot 0's.
    const argv = (StackDown.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(argv.slice(0, 2)).toEqual(['--slot', '2']);

    // AV stays on slot 0 (post-soa#271 doctrine) — warned, never errored.
    expect(warns.some((w) => /AV stays on slot 0/.test(w))).toBe(true);
  });

  it('--no-admin at --slot 2 prints a SLOT-PINNED login one-liner (stack login defaults to slot 0)', async () => {
    await DevelopSessionAdm.run(['--slot', '2', '--no-admin', ...ws()], config);
    const line = logs.find((l) => /ss stack login/.test(l));
    expect(line).toBeDefined();
    // Without --slot 2 the pasted command mints against slot 0's iam (:3010)
    // while LOGIN_DASH_URL points at the slot-2 dash — wrong-iam jar.
    expect(line).toContain('--slot 2');
    expect(line).toContain('http://localhost:10900/dashboard/attendance?mode=session');
  });

  it('the mint-failure remediation carries the slot AND a pinned --state-dir', async () => {
    installLoginSeams({ status: 500, ok: false, setCookies: [] });
    await DevelopSessionAdm.run(['--slot', '2', '--state-dir', '/tmp/pinned', ...ws()], config);
    const warn = warns.find((w) => /session mint failed/.test(w));
    expect(warn).toContain('--slot 2');
    expect(warn).toContain('--state-dir /tmp/pinned');
  });
});
