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
import type { LaunchSpec, RunResult, Runner, ScriptInvocation } from '../../../runtime/index.js';
import { useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import { pwArgv } from '../../../__tests__/helpers/pw.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import E2eRun from '../run.js';
import E2eList from '../list.js';
import E2eConnect from '../../develop/connect.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

let DASH_ROOT: string;
let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
let logged: string[];
let warned: string[];

// Hermetic snapshot root: `e2e list` reads it for the M14-C checkpoint
// annotation — never scan the developer's real ~/.saga-mesh/snapshots.
useTempSnapshotsDir('saga-e2e-list-');

/**
 * Compose the shared core-seam battery (helpers/seams.ts). pidBase/prepFresh
 * are EXPLICIT at this call site by design: pids at 2000+, and NEVER fresh
 * (the fixed /fixed/dev paths don't exist) ⇒ the R1 prep build runs; repos
 * reported present so no service is skipped. `launchFail` ids answer
 * health-down.
 */
function installSeams(launchFail: Set<string> = new Set()): void {
  const seams = installCoreSeams({ pidBase: 2000, prepFresh: false, launchFail });
  launches = seams.launches;
  runs = seams.runs;
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
    // GOLDEN ANCHOR (T5): this dry-run prose string stays fully literal on
    // purpose — do NOT rebuild it with helpers/pw.ts's pwArgv, so a drift in
    // the printed argv shape can never be masked by the builder drifting too.
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

    // FLIP 3 regression guard: the native prep pass runs at slot 0 now (up.sh --reset
    // no longer migrates the schema). R3 migrate ran `pnpm db:deploy` over the closure
    // DBs BEFORE the seed, so seed-dev-user no longer hits an unmigrated schema.
    expect(runs.some((r) => r.command === 'pnpm' && r.args.includes('db:deploy'))).toBe(true);

    // exactly one Playwright child, in the SPA appDir, with the resolved argv + date env.
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0].cwd).toBe(join(DASH_ROOT, 'apps', 'web', 'dash'));
    // VARIANT argv (T5): differs from run.int's golden literal pin only in the
    // project — built with the shared pwArgv (the literal shape protection
    // lives in run.int.test.ts's happy-path anchor).
    expect(pw[0].args).toEqual(pwArgv({ project: 'stage-1-roster', grepInvert: '@interactive' }));
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

  it('--fake-media: pins FAKE_MEDIA=1 on the headed interactive-connect run ONLY, not the journey prerequisite', async () => {
    await E2eConnect.run(['--fake-media', ...ws()], config);
    const pw = playwrightRuns();
    expect(pw).toHaveLength(2);
    // journey prerequisite (a separate ResolvedFlow) must NOT get FAKE_MEDIA.
    expect(pw[0].args).toContain('stage-5-schedule');
    expect(pw[0].env?.FAKE_MEDIA).toBeUndefined();
    // the headed live session does.
    expect(pw[1].args).toContain('interactive-connect');
    expect(pw[1].env?.FAKE_MEDIA).toBe('1');
  });

  it('bare (no --fake-media): interactive-connect runs with real media (no FAKE_MEDIA)', async () => {
    await E2eConnect.run([...ws()], config);
    const pw = playwrightRuns();
    expect(pw[1].args).toContain('interactive-connect');
    expect(pw[1].env?.FAKE_MEDIA).toBeUndefined();
  });

  it('--tunnel: the headed interactive-connect session drives the https tunnel hosts (soa#298)', async () => {
    // Never spawn the vendored tunnel.sh — inject a fixed moniker (run.int.test.ts pattern).
    vi.spyOn(BaseCommand.prototype as never, 'getTunnelMoniker' as never).mockReturnValue(
      (async () => 'testmoniker') as never,
    );
    await E2eConnect.run(['--tunnel', ...ws()], config);
    // The live session's env carries the tunnel URLs — proving tunnelDomain reached the
    // executeResolvedFlow deps (and buildStackContext) for the headed interactive run.
    const live = playwrightRuns().find((r) => r.args.includes('interactive-connect'));
    // dash is the non-derivable rename for saga-dash; <label>.<moniker>.<VMS_BASE>.
    expect(live?.env?.PLAYWRIGHT_BASE_URL).toMatch(/^https:\/\/dash\.testmoniker\./);
    expect(live?.env?.PLAYWRIGHT_BASE_URL).not.toContain('localhost');
    expect(live?.env?.PLAYWRIGHT_TUNNEL_TIMEOUT_MS).toMatch(/^\d+$/);
  });
});
