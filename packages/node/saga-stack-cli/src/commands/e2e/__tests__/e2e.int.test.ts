/**
 * e2e topic integration tests — the M5 NATIVE in-process orchestration.
 *
 * Drives the real oclif `e2e run/list/connect` commands end-to-end (parse →
 * discover flows.json → resolveFlow → StackApi.up/reset/seed/verify → Playwright
 * spawn) with EVERY IO seam on the BaseCommand prototype REPLACED by a fake:
 * `getLauncher` / `getMeshExec` / `getPortProbe` / `getDashFs` / `getProber` /
 * `getRunner`. NOTHING is spawned — no pnpm dev, no make, no up.sh, no playwright.
 *
 * Discovery falls back to the package's BUNDLED example flows.json for the
 * built-in `saga-dash` id (the repo's real flows.json is a follow-up PR), so the
 * suite is hermetic: it pins `--saga-dash` at a temp dir WITHOUT a flows.json and
 * asserts the bundled-example fallback path. `--soa` is the real soa checkout so
 * the delegated `up.sh --reset` resolves (it is never actually run — the fake
 * Runner records it).
 */

import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import E2eList from '../list.js';
import E2eConnect from '../connect.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

let DASH_ROOT: string;
let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
let logged: string[];
let warned: string[];

/** Install fakes for every native-path seam. `launchFail` ids answer health-down. */
function installSeams(launchFail: Set<string> = new Set()): void {
  launches = [];
  runs = [];

  const launcher: ServiceLauncher = {
    async launch(spec: LaunchSpec): Promise<LaunchResult> {
      launches.push(spec);
      return { id: spec.id, ok: !launchFail.has(spec.id), pid: 2000 + launches.length };
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
  const dashFs: DashFs = {
    existsDir: () => true,
    existsFile: () => false,
    remove: () => {},
    write: () => {},
  };
  const prober: HealthProber = {
    async probe(): Promise<ProbeResult> { return { ok: true, status: 200 }; },
  };
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

/** The Playwright child invocations the Runner recorded (command pnpm, args incl. playwright). */
function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}

beforeAll(() => {
  DASH_ROOT = mkdtempSync(join(tmpdir(), 'saga-dash-stub-'));
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

describe('e2e run — --dry-run (pure planner, touches no seam)', () => {
  it('journey --through pods: prints the narrowed 4-service closure, project stage-4-pods, occurrence date — no seam touched', async () => {
    await E2eRun.run(['journey', '--through', 'pods', '--dry-run', ...ws()], config);

    expect(launches).toEqual([]);
    expect(runs).toEqual([]);
    const text = logged.join('\n');
    expect(text).toContain('dry-run: saga-dash/journey');
    expect(text).toContain('stages: roster -> program -> enrollment -> pods');
    // N-of-M (§5.2): browser edges not followed ⇒ only iam+sis+programs+saga-dash.
    expect(text).toContain('closure (4):');
    expect(text).toMatch(/PLAYWRIGHT_OCCURRENCE_DATE: \d{4}-\d{2}-\d{2}/);
    // journey is foreground ⇒ headed by default; pipeline excludes @interactive.
    expect(text).toContain(
      'pnpm exec playwright test --config=playwright.stack.config.ts --project stage-4-pods --grep-invert @interactive --headed',
    );
  });

  it('connect-session: shows the recursed journey prerequisite + the interactive-connect terminal (no grep-invert)', async () => {
    await E2eRun.run(['connect-session', '--dry-run', ...ws()], config);
    const text = logged.join('\n');
    expect(text).toContain('prerequisite: saga-dash/journey (through schedule');
    // The terminal stage IS @interactive-tagged, so the main run does NOT invert it.
    expect(text).toContain('--project interactive-connect');
    expect(text).not.toMatch(/interactive-connect.*--grep-invert/);
  });

  it('--headless flips a foreground flow off headed', async () => {
    await E2eRun.run(['journey', '--through', '1', '--headless', '--dry-run', ...ws()], config);
    const text = logged.join('\n');
    expect(text).toContain('--project stage-1-roster');
    expect(text).not.toContain('--headed');
  });
});

describe('e2e run — native orchestration (stack lane)', () => {
  it('journey --through roster --headless: bundled-fallback notice, native up+reset+seed+verify, then playwright', async () => {
    await E2eRun.run(['journey', '--through', 'roster', '--headless', ...ws()], config);

    // bundled-example fallback announced.
    expect(warned.some((w) => w.includes('BUNDLED EXAMPLE'))).toBe(true);

    // up launched ONLY the through-roster closure natively (N-of-M, §5.2):
    // roster needs sis+programs; +saga-dash+iam. No scheduling/sessions/ads-adm/content.
    expect(launches.map((s) => s.id)).toEqual(['iam-api', 'sis-api', 'programs-api', 'saga-dash']);

    // FLIP 3: the slot-0 reset is NATIVE now — it NEVER delegates to up.sh --reset.
    // The closure DBs are truncated via docker-exec psql (preserving _prisma_migrations)
    // and the native roster seed ran.
    expect(runs.some((r) => r.command.endsWith('up.sh') && r.args.includes('--reset'))).toBe(false);
    expect(
      runs.some(
        (r) =>
          r.command === 'docker' &&
          r.args.includes('psql') &&
          r.args.includes('-c') &&
          r.args[r.args.indexOf('-c') + 1].includes("tablename <> '_prisma_migrations'"),
      ),
    ).toBe(true);
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
      'stage-1-roster',
      '--grep-invert',
      '@interactive',
    ]);
    expect(pw[0].env?.PLAYWRIGHT_OCCURRENCE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pw[0].stdio).toBe('inherit');
  });

  it('--skip-reset reuses state: no up.sh reset, no seed — but Playwright still runs', async () => {
    await E2eRun.run(['journey', '--through', 'roster', '--headless', '--skip-reset', ...ws()], config);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(false);
    expect(playwrightRuns()).toHaveLength(1);
  });

  it('propagates a non-zero Playwright exit code', async () => {
    // make the Playwright child (the only pnpm+playwright run) exit non-zero.
    const runner: Runner = {
      async run(spec: ScriptInvocation): Promise<RunResult> {
        runs.push(spec);
        const isPw = spec.command === 'pnpm' && spec.args.includes('playwright');
        return { code: isPw ? 7 : 0 };
      },
    };
    vi.spyOn(BaseCommand.prototype as unknown as Record<string, () => unknown>, 'getRunner').mockReturnValue(runner);

    await expect(
      E2eRun.run(['journey', '--through', 'roster', '--headless', '--skip-reset', ...ws()], config),
    ).rejects.toMatchObject({ oclif: { exit: 7 } });
  });

  it('fails before Playwright when a service never becomes healthy', async () => {
    installSeams(new Set(['iam-api']));
    await expect(
      E2eRun.run(['journey', '--through', 'roster', '--headless', ...ws()], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('bring-up failed') });
    expect(playwrightRuns()).toHaveLength(0);
  });
});

describe('e2e list — read-only registry/flows listing', () => {
  it('lists saga-dash (bundled) + its flows/phases and never fails on its own', async () => {
    await expect(E2eList.run([...ws()], config)).resolves.toBeUndefined();
    const text = logged.join('\n');
    expect(text).toContain('saga-dash');
    expect(text).toContain('journey');
    expect(text).toContain('connect-session');
    // connectv3 has no authored flows.json + no bundled example → reported, not thrown.
    expect(text).toContain('connectv3');
    expect(runs).toEqual([]);
    expect(launches).toEqual([]);
  });
});

describe('e2e connect — foreground connect-session entry', () => {
  it('bare: builds the journey prerequisite headless, then opens interactive-connect headed', async () => {
    await E2eConnect.run([...ws()], config);
    const pw = playwrightRuns();
    expect(pw).toHaveLength(2);
    // prerequisite first: journey through schedule, headless (no --headed).
    expect(pw[0].args).toContain('stage-5-schedule');
    expect(pw[0].args).not.toContain('--headed');
    // then the live session: interactive-connect, headed.
    expect(pw[1].args).toContain('interactive-connect');
    expect(pw[1].args).toContain('--headed');
  });

  it('--reuse: skips the prerequisite + reset; runs only the headed interactive session', async () => {
    await E2eConnect.run(['--reuse', ...ws(), '--', '--debug'], config);
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0].args).toContain('interactive-connect');
    expect(pw[0].args).toContain('--headed');
    // passthrough forwarded.
    expect(pw[0].args).toContain('--debug');
    // no rebuild ⇒ no up.sh reset / seed.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(false);
  });
});
