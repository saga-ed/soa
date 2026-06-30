/**
 * `e2e run` integration tests (plan §5.4 / §7.2 "M5") — the in-process native
 * orchestrator, driven through the REAL oclif command with every BaseCommand IO
 * seam replaced by a fake. NOTHING is spawned: no pnpm, no make, no up.sh, no
 * Playwright — the fake Runner/Launcher/Prober record the intended invocations.
 *
 * Complements `e2e.int.test.ts` (which covers run --through roster, list, and
 * connect): this file pins the `e2e run` command to the scenarios the M5 plan
 * calls out explicitly — the `--through pods` plan + native path (terminal
 * project `stage-4-pods`, the narrowed-but-still-full saga-dash closure), and
 * the `e2e run saga-dash/connect-session` prerequisite recursion (two Playwright
 * children: the headless journey-through-schedule build, then the headed room).
 *
 * Hermetic: discovery falls back to the package's BUNDLED example flows.json for
 * the built-in `saga-dash` id (`--saga-dash` points at a temp dir with no
 * flows.json), and `--soa` is the real checkout so the delegated `up.sh --reset`
 * path resolves (it is never run — the fake Runner records it).
 */

import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type {
  DashFs,
  HealthProber,
  LaunchResult,
  LaunchSpec,
  MeshExec,
  PortProbe,
  ProbeResult,
  RunResult,
  Runner,
  ScriptInvocation,
  ServiceLauncher,
  StopResult,
} from '../../../runtime/index.js';
import E2eRun from '../run.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

let DASH_ROOT: string;
let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
let logged: string[];
let warned: string[];

/** Install fakes for every native-path seam. Ids in `launchFail` answer health-down. */
function installSeams(launchFail: Set<string> = new Set()): void {
  launches = [];
  runs = [];

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      launches.push(spec);
      return { id: spec.id, ok: !launchFail.has(spec.id), pid: 3000 + launches.length };
    },
    async stopServices(ids: string[]): Promise<StopResult[]> {
      return ids.map((id) => ({ id, stopped: true }));
    },
  };
  const meshExec: MeshExec = { async ready(): Promise<boolean> { return true; } };
  const portProbe: PortProbe = {
    async dockerHolder(): Promise<string | null> { return null; },
    async listening(): Promise<boolean> { return false; },
  };
  const dashFs: DashFs = { existsDir: () => true, existsFile: () => false, remove: () => {}, write: () => {} };
  const prober: HealthProber = { async probe(): Promise<ProbeResult> { return { ok: true, status: 200 }; } };
  const runner: Runner = {
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runs.push(spec);
      return { code: 0 };
    },
  };

  const proto = BaseCommand.prototype as unknown as Record<string, () => unknown>;
  vi.spyOn(proto, 'getLauncher').mockReturnValue(launcher);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(meshExec);
  vi.spyOn(proto, 'getPortProbe').mockReturnValue(portProbe);
  vi.spyOn(proto, 'getDashFs').mockReturnValue(dashFs);
  vi.spyOn(proto, 'getProber').mockReturnValue(prober);
  vi.spyOn(proto, 'getRunner').mockReturnValue(runner);
}

/** Workspace flags: stub saga-dash (no flows.json → bundled fallback) + real soa. */
function ws(): string[] {
  return ['--saga-dash', DASH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT];
}

/** The Playwright child invocations the Runner recorded. */
function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-run-'));
});
afterAll(() => {
  rmSync(DASH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installSeams();
  logged = [];
  warned = [];
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
    logged.push(String(m ?? ''));
  });
  vi.spyOn(BaseCommand.prototype, 'warn').mockImplementation(((m: string) => {
    warned.push(String(m));
    return m;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('e2e run — --dry-run plan (touches no seam)', () => {
  it('journey --through pods --headless: prints stages, closure, occurrence date + playwright argv; launches nothing', async () => {
    await E2eRun.run(['journey', '--through', 'pods', '--headless', '--dry-run', ...ws()], config);

    // Pure projection — no launch, no Runner invocation at all.
    expect(launches).toEqual([]);
    expect(runs).toEqual([]);

    const text = logged.join('\n');
    expect(text).toContain('dry-run: saga-dash/journey (lane stack, headless)');
    expect(text).toContain('stages: roster -> program -> enrollment -> pods');
    // N-of-M (§5.2): stopping at pods narrows the closure to 4 (browser edges
    // not followed) — scheduling/sessions/ads-adm/content stay down.
    expect(text).toContain('closure (4):');
    expect(text).toMatch(/PLAYWRIGHT_OCCURRENCE_DATE: \d{4}-\d{2}-\d{2}/);
    // --headless flips the foreground default off; terminal project is stage-4-pods.
    expect(text).toContain(
      'pnpm exec playwright test --config=playwright.stack.config.ts --project stage-4-pods --grep-invert @interactive',
    );
    expect(text).not.toContain('--headed');
  });

  it('saga-dash/connect-session --dry-run: shows the recursed journey prerequisite + the non-inverted interactive project', async () => {
    await E2eRun.run(['saga-dash/connect-session', '--dry-run', ...ws()], config);
    expect(runs).toEqual([]);
    const text = logged.join('\n');
    expect(text).toContain('prerequisite: saga-dash/journey (through schedule, headless)');
    expect(text).toContain('--project interactive-connect');
    // The terminal stage IS @interactive — the main run must NOT --grep-invert it.
    expect(text).not.toMatch(/interactive-connect.*--grep-invert/);
  });
});

describe('e2e run — native orchestration (stack lane)', () => {
  it('journey --through pods --headless: native up+reset+seed+verify, then ONE Playwright child at stage-4-pods', async () => {
    await E2eRun.run(['journey', '--through', 'pods', '--headless', ...ws()], config);

    // bundled-example fallback was announced.
    expect(warned.some((w) => w.includes('BUNDLED EXAMPLE'))).toBe(true);

    // up launched ONLY the through-pods closure natively (N-of-M, §5.2): the
    // flow's requiredSystems drive it; saga-dash's browser edges are NOT followed.
    expect(launches.map((s) => s.id)).toEqual(['iam-api', 'sis-api', 'programs-api', 'saga-dash']);

    // reset delegated to up.sh + the native roster seed ran.
    expect(runs.some((r) => r.command.endsWith('up.sh') && r.args.includes('--reset'))).toBe(true);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(true);

    // exactly one Playwright child, in the SPA appDir, with the resolved argv + date env.
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0].cwd).toBe(join(DASH_ROOT, 'apps', 'web', 'dash'));
    expect(pw[0].args).toEqual([
      'exec',
      'playwright',
      'test',
      '--config=playwright.stack.config.ts',
      '--project',
      'stage-4-pods',
      '--grep-invert',
      '@interactive',
    ]);
    expect(pw[0].args).not.toContain('--headed');
    expect(pw[0].env?.PLAYWRIGHT_OCCURRENCE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pw[0].env?.PLAYWRIGHT_TERM_START).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pw[0].stdio).toBe('inherit');
  });

  it('forwards passthrough args after `--` to the Playwright child only', async () => {
    await E2eRun.run(['journey', '--through', 'pods', '--headless', '--skip-reset', ...ws(), '--', '--debug'], config);
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0].args.at(-1)).toBe('--debug');
    // --skip-reset ⇒ no up.sh reset, no seed.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(false);
  });

  it('saga-dash/connect-session: builds the journey prerequisite headless, then opens the headed room (two children)', async () => {
    await E2eRun.run(['saga-dash/connect-session', ...ws()], config);
    const pw = playwrightRuns();
    expect(pw).toHaveLength(2);
    // 1) the prerequisite: journey through schedule, headless.
    expect(pw[0].args).toContain('stage-5-schedule');
    expect(pw[0].args).not.toContain('--headed');
    // 2) the live session: interactive-connect, headed, tag not inverted.
    expect(pw[1].args).toContain('interactive-connect');
    expect(pw[1].args).toContain('--headed');
    expect(pw[1].args).not.toContain('--grep-invert');
  });

  it('propagates a non-zero Playwright exit code as the command exit', async () => {
    const runner: Runner = {
      async run(spec: ScriptInvocation): Promise<RunResult> {
        runs.push(spec);
        const isPw = spec.command === 'pnpm' && spec.args.includes('playwright');
        return { code: isPw ? 9 : 0 };
      },
    };
    vi.spyOn(BaseCommand.prototype as unknown as Record<string, () => unknown>, 'getRunner').mockReturnValue(runner);

    await expect(
      E2eRun.run(['journey', '--through', 'pods', '--headless', '--skip-reset', ...ws()], config),
    ).rejects.toMatchObject({ oclif: { exit: 9 } });
  });

  it('aborts before Playwright when a service never becomes healthy', async () => {
    installSeams(new Set(['iam-api']));
    await expect(
      E2eRun.run(['journey', '--through', 'pods', '--headless', ...ws()], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('bring-up failed') });
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('rejects --headed together with --headless', async () => {
    await expect(
      E2eRun.run(['journey', '--headed', '--headless', ...ws()], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('mutually exclusive') });
  });
});
