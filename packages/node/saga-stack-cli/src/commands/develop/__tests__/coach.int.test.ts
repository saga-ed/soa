/**
 * `develop coach` integration tests (gh_305 M3) — the coach concierge driven
 * through the REAL oclif command with every BaseCommand IO seam faked. NOTHING is
 * spawned: the fake Runner/Launcher/Prober record the intended invocations.
 *
 * Coverage: command wiring (`--help` renders; the command resolves), the
 * scenario→flow/persona/route mapping (content-viewer→module-playback→demo-tutor-1
 * vs admin→dashboard→demo-dadmin), the mock-backed admin note, --reuse, and the
 * `--scenario playlist` coach#238 feature-detect (fail-fast when the verb is
 * absent; orchestrate publish/assign/materialize when present).
 *
 * Hermetic: a real coach `flows.json` (copied structure) is written into a temp
 * COACH checkout that `--coach` points at, so discovery resolves coach-web's
 * authored flows without touching the developer's real `$COACH`.
 */

import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { ScriptInvocation } from '../../../runtime/index.js';
import type { CookiePoster, JarWriter, PostOptions, PostResult } from '../../../runtime/index.js';
import { useTempSnapshotsDir } from '../../../__tests__/helpers/env.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import DevelopCoach from '../coach.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';

/**
 * The 2nd track `--scenario playlist` switches onto — the MATERIALIZABLE curriculum
 * coach-db's seed ships (fixtures/content-release.json → curriculum-coach-b). MUST
 * stay in lock-step with coach.ts's `PLAYLIST_TRACK_2`.
 */
const PLAYLIST_TRACK_2 = 'curriculum-coach-b';
/**
 * demo-tutor-1's DERIVED coach user id (`deriveUserId('demo-tutor-1')`) — the id
 * coach-web's whoami reads by and the seed keys the tutor's instance to. materialize
 * MUST use this, not the `demo-tutor-1` handle. Mirrors coach.ts's COACH_TUTOR_USER_ID.
 */
const COACH_TUTOR_UUID = '1c939568-1464-5f9a-b5a4-0bc73a0454cb';

/** coach-web's authored flows.json (the fields the resolver + our command read). */
const COACH_FLOWS = {
  schemaVersion: 1,
  spa: {
    id: 'coach-web',
    system: 'coach-web',
    repoEnvVar: 'COACH',
    defaultRepoSubpath: 'coach',
    appDir: 'apps/web/coach-web',
    e2eDir: 'apps/web/coach-web/e2e',
    playwrightConfig: 'playwright.config.ts',
  },
  flows: [
    {
      name: 'dashboard',
      description: 'Authenticated tutor dashboard.',
      lanes: ['stack'],
      progressive: false,
      seed: { profile: 'full', reset: true },
      stages: [
        {
          id: 'dashboard',
          phase: 1,
          project: 'chromium',
          spec: 'dashboard/dashboard-authenticated.e2e.smoke.test.ts',
          requiredSystems: ['coach-web', 'coach-api', 'iam-api'],
        },
      ],
    },
    {
      name: 'module-playback',
      description: 'In-app module playback.',
      lanes: ['stack'],
      progressive: false,
      seed: { profile: 'full', reset: true },
      stages: [
        {
          id: 'module-playback',
          phase: 1,
          project: 'chromium',
          spec: 'module-playback/module-playback.e2e.smoke.test.ts',
          requiredSystems: ['coach-web', 'coach-api', 'iam-api'],
        },
      ],
    },
    {
      name: 'module-playback-real-content',
      description: 'Module playback against REAL archive curriculum (base-coach).',
      lanes: ['stack'],
      progressive: false,
      seed: { profile: 'full', reset: true },
      // The flow itself supplies the gate; the invoker supplies only ARCHIVE_DIR.
      env: { PUBLISH_REAL_CONTENT: '1' },
      stages: [
        {
          id: 'module-playback-real-content',
          phase: 1,
          project: 'chromium',
          spec: 'module-playback-real-content/module-playback-real-content.e2e.test.ts',
          requiredSystems: ['coach-web', 'coach-api', 'iam-api'],
        },
      ],
    },
  ],
};

let COACH_ROOT: string;
let config: Config;
let launches: ReturnType<typeof installCoreSeams>['launches'];
let runs: ScriptInvocation[];
let logged: string[];
let warned: string[];

useTempSnapshotsDir('saga-coach-snaps-');

/** Workspace flags: temp COACH (with the authored flows.json) + real soa. */
function ws(): string[] {
  return ['--coach', COACH_ROOT, '--soa', SOA_ROOT, '--dev', DEV_ROOT];
}

/** The Playwright child invocations the Runner recorded. */
function playwrightRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('playwright'));
}
/** The vendored browser-login.mjs child invocation (the hand-off). */
function browserRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'node' && (r.args[0] ?? '').endsWith('browser-login.mjs'));
}
/** The coach-content CLI invocations the Runner recorded (playlist orchestration). */
function coachContentRuns(): ScriptInvocation[] {
  return runs.filter((r) => r.command === 'pnpm' && r.args.includes('coach-content'));
}

// Native-login seams (cookie poster + jar writer), mirroring run.int.test.ts.
let posts: { url: string; opts: PostOptions }[];
let jarWrites: { path: string; contents: string }[];
const OK_COOKIES: PostResult = {
  status: 200,
  ok: true,
  setCookies: ['iam_session=jwt.tok.sig; Path=/; HttpOnly', 'iam_refresh=refr; Path=/; HttpOnly'],
};

function installLoginSeams(result: PostResult = OK_COOKIES): void {
  posts = [];
  jarWrites = [];
  const poster: CookiePoster = {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      posts.push({ url, opts });
      return result;
    },
  };
  const jar: JarWriter = { write: (path, contents) => jarWrites.push({ path, contents }) };
  vi.spyOn(BaseCommand.prototype as never, 'getCookiePoster' as never).mockReturnValue(poster as never);
  vi.spyOn(BaseCommand.prototype as never, 'getJarWriter' as never).mockReturnValue(jar as never);
}

/**
 * Stub the repo-dir existence seam. `playlistVerb` controls whether the coach#238
 * `coach-content/src/playlist.ts` feature-detect passes; every OTHER path
 * (coach-web appDir for the browser step) reports present so the hand-off runs.
 */
/** Stub the repo-dir seam so the `--real-content` precheck sees (or misses) an archive checkout. */
function installArchiveDirCheck(present: boolean): void {
  vi.spyOn(BaseCommand.prototype as never, 'getRepoDirCheck' as never).mockReturnValue(((dir: string) => {
    if (dir.endsWith(join('content-archive', '.git'))) return present;
    return true;
  }) as never);
}

function installRepoDirCheck(playlistVerb: boolean): void {
  vi.spyOn(BaseCommand.prototype as never, 'getRepoDirCheck' as never).mockReturnValue(((dir: string) => {
    if (dir.endsWith(join('coach-content-publish', 'src', 'playlist.ts'))) return playlistVerb;
    return true;
  }) as never);
}

/**
 * Stub the repo-file-read seam so the playlist precheck reads a coach-db seed
 * fixture carrying exactly `tracks` as its curricula names. Any other path reads
 * as absent (undefined), mirroring the real seam's error → undefined contract.
 */
function installRepoFileRead(tracks: string[]): void {
  vi.spyOn(BaseCommand.prototype as never, 'getRepoFileRead' as never).mockReturnValue(((path: string) => {
    if (path.endsWith(join('coach-db', 'src', 'seed', 'fixtures', 'content-release.json'))) {
      return JSON.stringify({ curricula: tracks.map((name) => ({ name })) });
    }
    return undefined;
  }) as never);
}

beforeAll(() => {
  COACH_ROOT = mkdtempSync(join(tmpdir(), 'coach-dev-'));
  const e2eDir = join(COACH_ROOT, 'apps', 'web', 'coach-web', 'e2e');
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(join(e2eDir, 'flows.json'), JSON.stringify(COACH_FLOWS), 'utf8');
});
afterAll(() => {
  rmSync(COACH_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  const seams = installCoreSeams({ pidBase: 3000, prepFresh: true });
  launches = seams.launches;
  runs = seams.runs;
  logged = [];
  warned = [];
  installLoginSeams();
  installRepoDirCheck(true);
  installRepoFileRead([PLAYLIST_TRACK_2]);
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

describe('develop coach — content-viewer (default scenario)', () => {
  it('brings up the coach closure, seeds full, drives module-playback, hands off demo-tutor-1 at the module player', async () => {
    await DevelopCoach.run([...ws()], config);

    // the coach closure came up (coach-web + coach-api + iam-api at minimum).
    const ids = launches.map((s) => s.id);
    expect(ids).toContain('coach-web');
    expect(ids).toContain('coach-api');
    expect(ids).toContain('iam-api');

    // full seed ran the coach pg seed (db:seed) — NOT skipped.
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(true);

    // exactly one Playwright child, in coach-web's appDir; the flow mapping shows
    // in the hand-off summary (both coach flows share the `chromium` project).
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(pw[0].cwd).toBe(join(COACH_ROOT, 'apps', 'web', 'coach-web'));
    expect(logged.join('\n')).toContain('coach-web/module-playback');

    // hand-off: demo-tutor-1 jar minted, then a headed coach-web at the module route.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.opts.body).toContain('demo-tutor-1@saga.org');
    const br = browserRuns();
    expect(br).toHaveLength(1);
    expect(br[0].env?.LOGIN_EMAIL).toBe('demo-tutor-1@saga.org');
    expect(br[0].env?.DASH_URL).toBe('http://localhost:8800/units/unit_1/sc_u1_m1');

    expect(logged.join('\n')).toContain("coach ready — scenario 'content-viewer'");
  });

  it('--reuse skips the reset+seed but still hands off', async () => {
    await DevelopCoach.run(['--reuse', ...ws()], config);
    expect(runs.some((r) => r.args.includes('db:seed'))).toBe(false);
    expect(browserRuns()).toHaveLength(1);
  });
});

describe('develop coach — slot awareness (slot > 0)', () => {
  it('accepts --slot 2 (slotAware) and still hands off', async () => {
    // Was a hard-error before slotAware(): a per-slot dev concierge must run at
    // slot > 0. (The concrete hand-off port at slot > 0 is verified live — the
    // test harness mocks the port probe to fixed values, so it cannot assert the
    // real mesh offset here.)
    await DevelopCoach.run(['--slot', '2', ...ws()], config);
    expect(browserRuns()).toHaveLength(1);
  });

  it('--tunnel --slot 2 hard-errors (tunnel fronts fixed slot-0 ports)', async () => {
    await expect(DevelopCoach.run(['--tunnel', '--slot', '2', ...ws()], config)).rejects.toThrow(/slot 2:.*slot-0 browser ports/);
  });
});

describe('develop coach — admin (descoped, mock-backed)', () => {
  it('drives the dashboard flow, logs in demo-dadmin at /reports, and WARNS that the report is mock-backed', async () => {
    await DevelopCoach.run(['--scenario', 'admin', ...ws()], config);

    // admin maps to the dashboard flow (not module-playback).
    const pw = playwrightRuns();
    expect(pw).toHaveLength(1);
    expect(logged.join('\n')).toContain('coach-web/dashboard');

    // logged in as the district-admin persona at /reports.
    expect(posts[0]?.opts.body).toContain('demo-dadmin@saga.org');
    const br = browserRuns();
    expect(br[0].env?.LOGIN_EMAIL).toBe('demo-dadmin@saga.org');
    expect(br[0].env?.DASH_URL).toBe('http://localhost:8800/reports');

    // the mock-backed caveat is surfaced.
    expect(warned.some((w) => w.includes('mock-backed') || w.includes('MOCK data'))).toBe(true);
  });
});

describe('develop coach — --real-content (REAL archive curriculum)', () => {
  afterEach(() => {
    delete process.env.ARCHIVE_DIR; // the command exports it for the flow; don't leak across tests.
  });

  it('fails fast with an actionable message when the content-archive checkout is ABSENT — before any bring-up', async () => {
    installArchiveDirCheck(false); // <archive>/.git not present
    await expect(DevelopCoach.run(['--real-content', ...ws()], config)).rejects.toMatchObject({
      message: expect.stringContaining('content-archive'),
    });
    // fail-fast: no docker/seed spent on a run the flow would only self-skip.
    expect(launches).toEqual([]);
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('--real-content on a non-content-viewer scenario hard-errors', async () => {
    await expect(DevelopCoach.run(['--real-content', '--scenario', 'admin', ...ws()], config)).rejects.toThrow(
      /--real-content applies to --scenario content-viewer/,
    );
  });

  it('drives the AUTHORED real-content flow, exports ARCHIVE_DIR, and still hands off the logged-in tutor', async () => {
    installRepoDirCheck(true);
    await DevelopCoach.run(['--real-content', '--archive-dir', '/fixed/dev/content-archive', ...ws()], config);

    // the REAL-archive flow (publish base-coach → materialize), not the synthetic fixture.
    expect(logged.join('\n')).toContain('coach-web/module-playback-real-content');
    // ARCHIVE_DIR is the one thing the authored flow needs from the invoking env
    // (its flows.json env block supplies PUBLISH_REAL_CONTENT=1).
    expect(process.env.ARCHIVE_DIR).toBe('/fixed/dev/content-archive');
    const br = browserRuns();
    expect(br[0].env?.LOGIN_EMAIL).toBe('demo-tutor-1@saga.org');
  });
});

describe('develop coach — playlist (coach#238 feature-detect)', () => {
  it('fails fast with an actionable coach#238 message when the playlist verb is ABSENT — before any bring-up', async () => {
    installRepoDirCheck(false); // coach-content/src/playlist.ts not present
    await expect(DevelopCoach.run(['--scenario', 'playlist', ...ws()], config)).rejects.toMatchObject({
      message: expect.stringContaining('coach#238'),
    });
    // fail-fast: nothing was launched and no Playwright ran.
    expect(launches).toEqual([]);
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('fails fast when the coach seed does NOT ship the materializable 2nd track — before any bring-up', async () => {
    installRepoDirCheck(true); // verb present…
    installRepoFileRead(['curriculum-coach']); // …but the seed lacks curriculum-coach-b
    await expect(DevelopCoach.run(['--scenario', 'playlist', ...ws()], config)).rejects.toMatchObject({
      message: expect.stringContaining(PLAYLIST_TRACK_2),
    });
    // fail-fast: nothing was launched and no Playwright ran.
    expect(launches).toEqual([]);
    expect(playwrightRuns()).toHaveLength(0);
  });

  it('when the verb + seeded track are present: brings up + seeds, assigns + materializes the SEEDED 2nd track keyed by the derived user id, then hands off', async () => {
    installRepoDirCheck(true);
    installRepoFileRead([PLAYLIST_TRACK_2]);
    await DevelopCoach.run(['--scenario', 'playlist', ...ws()], config);

    // the coach-owned track switch ran against the mesh coach_api pg.
    const cc = coachContentRuns();
    const assign = cc.find((r) => r.args.includes('assign'));
    const materialize = cc.find((r) => r.args.includes('materialize'));
    expect(assign).toBeDefined();
    expect(assign?.args).toContain('playlist');
    expect(assign?.args).toContain('--group');

    // The materialize target is the SAME track the assign uses AND the one the
    // precheck confirmed the seed ships — not a name nothing ensures exists.
    const assignContent = assign?.args[(assign?.args.indexOf('--content') ?? -1) + 1];
    const materializeContent = materialize?.args[(materialize?.args.indexOf('--content') ?? -1) + 1];
    expect(assignContent).toBe(PLAYLIST_TRACK_2);
    expect(materializeContent).toBe(PLAYLIST_TRACK_2);

    expect(materialize).toBeDefined();
    expect(materialize?.args).toContain('--replace');
    // Keyed by the tutor's DERIVED user id (what coach-web reads by), NOT the
    // 'demo-tutor-1' handle — the switched instance is invisible in-app otherwise.
    const materializeUser = materialize?.args[(materialize?.args.indexOf('--user') ?? -1) + 1];
    expect(materializeUser).toBe(COACH_TUTOR_UUID);
    expect(materialize?.args).not.toContain('demo-tutor-1');

    // both carry the coach_api DATABASE_URL so they hit the mesh pg.
    expect(assign?.env?.DATABASE_URL).toContain('coach_api');

    // and it still handed off a logged-in coach-web.
    expect(browserRuns()).toHaveLength(1);
  });
});

describe('develop coach — command wiring', () => {
  it('rejects an unknown --scenario value (oclif options)', async () => {
    await expect(DevelopCoach.run(['--scenario', 'bogus', ...ws()], config)).rejects.toMatchObject({
      message: expect.stringContaining('bogus'),
    });
  });
});
