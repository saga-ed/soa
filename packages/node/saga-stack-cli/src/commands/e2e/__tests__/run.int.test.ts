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
import type { LaunchSpec, RunResult, Runner, ScriptInvocation } from '../../../runtime/index.js';
import { useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
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
let launcherSpy: ReturnType<typeof vi.spyOn>;

// Hermetic snapshot root: prerequisite flows construct a checkpoint store by
// default (M14-C) — never read (or restore from!) the developer's real
// ~/.saga-mesh/snapshots in a unit test.
useTempSnapshotsDir('saga-run-snaps-');

/**
 * Compose the shared core-seam battery (helpers/seams.ts). pidBase/prepFresh
 * are EXPLICIT at this call site by design: pids at 3000+, and repos reported
 * FRESH so the R1 prep build is skipped (FLIP 3's provision/migrate/reset pass
 * still runs at every slot through the shared Runner + stateful pgProbe).
 * Ids in `launchFail` answer health-down. The launcher spy is captured — the
 * M7 slot test asserts the state dir `getLauncher` was called with.
 */
function installSeams(launchFail: Set<string> = new Set()): void {
  const seams = installCoreSeams({ pidBase: 3000, prepFresh: true, launchFail, captureLauncherSpy: true });
  launches = seams.launches;
  runs = seams.runs;
  launcherSpy = seams.launcherSpy!;
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
    // GOLDEN ANCHOR (T5): this dry-run prose string stays fully literal on
    // purpose — do NOT rebuild it with helpers/pw.ts's pwArgv, so a drift in
    // the printed argv shape can never be masked by the builder drifting too.
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

    // FLIP 3: the slot-0 reset is NATIVE now — it NEVER delegates to up.sh --reset.
    // The closure DBs are truncated via docker-exec psql and the native roster seed ran.
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
    // GOLDEN ANCHOR (T5): the happy-path exact-array pin stays fully literal on
    // purpose — do NOT rebuild it with helpers/pw.ts's pwArgv. It is the one
    // assertion that protects the spawned argv SHAPE itself (order + every
    // token); building it with the same helper the variants use would let a
    // builder bug and an orchestrator bug cancel out.
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

describe('e2e run — slot isolation (M7)', () => {
  /** Pull the emitted `--output-json` dry-run object out of the logged lines. */
  function dryRunJson(): Record<string, unknown> {
    const line = logged.find((l) => l.trim().startsWith('{'));
    if (!line) throw new Error(`no JSON emitted; logged: ${logged.join('\\n')}`);
    return JSON.parse(line) as Record<string, unknown>;
  }

  it('--slot 1 --dry-run: no hard-error (slotAware), OFFSET service URLs, excluded service dropped', async () => {
    // The full journey closure includes ads-adm-api (attendance) — SLOTTABLE
    // now (tokenized env + EXPRESS_SERVER_PORT injection), so it STAYS in the
    // slot's closure. --slot 1 must be ACCEPTED (was a hard-error before slotAware).
    await E2eRun.run(['journey', '--slot', '1', '--dry-run', '--output-json', ...ws()], config);

    const json = dryRunJson();
    const closure = json.closure as { services: string[] };
    const env = json.env as Record<string, string>;

    // ads-adm-api is slottable — kept in the slot's closure; connect stays excluded.
    expect(closure.services).toContain('ads-adm-api');
    expect(closure.services).not.toContain('connect-api');
    expect(closure.services).toContain('iam-api');
    expect(closure.services).toContain('scheduling-api');

    // every injected Playwright service URL carries the +1000 offset.
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:9900'); // saga-dash → :9900
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:4010');
    expect(env.PLAYWRIGHT_SCHEDULING_URL).toBe('http://localhost:4008');
    expect(env.PLAYWRIGHT_SESSIONS_URL).toBe('http://localhost:4007');
    expect(env.PLAYWRIGHT_ADS_ADM_URL).toBe('http://localhost:6005'); // 5005 + 1000
  });

  it('--slot 0 --dry-run: BASE service URLs, excluded service PRESENT (byte-identical)', async () => {
    await E2eRun.run(['journey', '--slot', '0', '--dry-run', '--output-json', ...ws()], config);

    const json = dryRunJson();
    const closure = json.closure as { services: string[] };
    const env = json.env as Record<string, string>;

    // nothing excluded at slot 0 — the full closure, ads-adm-api included.
    expect(closure.services).toContain('ads-adm-api');

    // base ports (the split-brain guard — slot 0 stays on the defaults).
    expect(env.PLAYWRIGHT_BASE_URL).toBe('http://localhost:8900');
    expect(env.PLAYWRIGHT_IAM_URL).toBe('http://localhost:3010');
    expect(env.PLAYWRIGHT_SCHEDULING_URL).toBe('http://localhost:3008');
    expect(env.PLAYWRIGHT_SESSIONS_URL).toBe('http://localhost:3007');
  });

  it('--slot 1 real run: ads-adm-api LAUNCHES in-slot, verify probes OFFSET ports, Playwright env drives the OFFSET URLs, reset is native (not up.sh)', async () => {
    // Record every health-probe URL: the e2e verify step must probe the SLOT's
    // offset ports, never the manifest base ports (a base-port probe reads slot
    // 0's services — false-PASS off a healthy slot 0 / false-FAIL when slot 0 is
    // down, observed live at slot 2 with a green ads-adm-api on :7005).
    const probed: string[] = [];
    vi.spyOn(BaseCommand.prototype as never, 'getProber' as never).mockReturnValue({
      async probe(url: string) {
        probed.push(url);
        return { ok: true, status: 200 };
      },
    } as never);

    await E2eRun.run(
      ['journey', '--through', 'attendance', '--headless', '--slot', '1', ...ws()],
      config,
    );

    // verify probed ads-adm-api (and iam) on the slot's OFFSET ports only.
    expect(probed).toContain('http://localhost:6005/health'); // ads-adm 5005 + 1000
    expect(probed).toContain('http://localhost:4010/health'); // iam 3010 + 1000
    expect(probed.some((u) => u.includes(':5005') || u.includes(':3010'))).toBe(false);

    // ads-adm-api (required by the attendance stage) is slottable — LAUNCHED at
    // slot 1 on its offset port, told its listen port via EXPRESS_SERVER_PORT.
    const adsAdm = launches.find((s) => s.id === 'ads-adm-api');
    expect(adsAdm).toBeDefined();
    expect(adsAdm?.healthUrl).toContain(':6005'); // 5005 + 1000, not slot 0's :5005
    expect(adsAdm?.env.EXPRESS_SERVER_PORT).toBe('6005');
    // …and the other slottable backends still come up on their offset ports.
    expect(launches.map((s) => s.id)).toContain('iam-api');
    const iam = launches.find((s) => s.id === 'iam-api');
    expect(iam?.healthUrl).toContain(':4010'); // offset launch, not :3010

    // the reset routed NATIVELY (slot-aware) — NOT the slot-0-hardcoded up.sh --reset.
    expect(runs.some((r) => r.command.endsWith('up.sh') && r.args.includes('--reset'))).toBe(false);

    // the Playwright child drives the slot's OWN service URLs (the split-brain guard).
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0].env?.PLAYWRIGHT_BASE_URL).toBe('http://localhost:9900');
    expect(pw[0].env?.PLAYWRIGHT_IAM_URL).toBe('http://localhost:4010');
    expect(pw[0].env?.PLAYWRIGHT_SCHEDULING_URL).toBe('http://localhost:4008');
  });

  it('--slot 1 points the launcher at the slot state dir (/tmp/sds-synthetic-s1) for pid/log isolation', async () => {
    await E2eRun.run(['journey', '--through', 'pods', '--headless', '--slot', '1', ...ws()], config);
    // the launcher seam was built with the slot's isolated state dir (no --state-dir given).
    expect(launcherSpy).toHaveBeenCalledWith('/tmp/sds-synthetic-s1');
  });
});
