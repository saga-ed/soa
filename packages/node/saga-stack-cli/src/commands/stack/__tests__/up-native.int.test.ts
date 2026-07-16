/**
 * `stack up --only` NATIVE partial-stack integration tests (plan §6.3, §7.2 "M4").
 *
 * M4's headline payoff: `stack up --only <svc,…>` (without --dry-run) boots ONLY
 * the computed dependency closure FOR REAL — natively, NOT by shelling out to
 * up.sh. These tests drive the REAL StackUp command end-to-end (parse argv →
 * computeClosure → makeStackApi → up()+seed()) but REPLACE every IO seam on the
 * BaseCommand prototype with a fake: `getLauncher` / `getMeshExec` / `getPortProbe`
 * / `getDashFs` / `getRunner`. NOTHING is spawned: no pnpm dev, no make, no docker.
 *
 * The native path takes over `--only` entirely; the up.sh-wrapper fallback (single
 * service + a native-unsupported flag) and the full-stack wrapper live in
 * wrappers.int.test.ts (which only mocks getRunner).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type {
  CookiePoster,
  DashFs,
  GitRunner,
  JarWriter,
  LaunchSpec,
  MeshExec,
  PostOptions,
  PostResult,
  ScriptInvocation,
  ViteClear,
} from '../../../runtime/index.js';
import { restoreEnv, saveEnv, type EnvSnapshot } from '../../../__tests__/helpers/env.js';
import { installCoreSeams } from '../../../__tests__/helpers/seams.js';
import StackUp from '../up.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

let config: Config;
let launches: LaunchSpec[];
let runs: ScriptInvocation[];
let posts: { url: string; opts: PostOptions }[];
let jarWrites: { path: string; contents: string }[];
let meshGated: string[];
let dashCalls: string[];
let recordUps: { plan: import('../../../core/record-plan.js').RecordPlan; ctx: { qboardRoot: string } }[];
let fleetGenCalls: { localFleetPath: string; outPath: string; tunnelDomain: string }[];

/** Install fakes for ALL native-path seams. `launchFail` ids answer health-down. */
function installNativeSeams(launchFail: Set<string> = new Set()): void {
  posts = [];
  jarWrites = [];
  meshGated = [];
  dashCalls = [];
  recordUps = [];
  fleetGenCalls = [];

  // Shared core battery (helpers/seams.ts): launcher/portProbe/runner-with-
  // CREATE-DATABASE-tracker/stateful pgProbe/prepFresh/dbGenerateScan/
  // repoDirCheck (+ silent meshExec/dashFs placeholders this suite RE-SPIES
  // below with recording fakes). pidBase/prepFresh are EXPLICIT at this call
  // site by design: pids at 2000+, and NEVER fresh (the fixed /fixed/dev paths
  // don't exist) ⇒ the R1 prep pass runs.
  const seams = installCoreSeams({ pidBase: 2000, prepFresh: false, launchFail });
  launches = seams.launches;
  runs = seams.runs;

  // Stateful DB existence lives in the core battery: a DB is ABSENT until R2
  // provision runs its `CREATE DATABASE <name>` psql, after which it EXISTS —
  // modelling the real `up --reset` order (provision → reset): every DB probes
  // absent at provision time (so provision CREATEs each), but exists by RESET
  // time (so the R4 reset's existence probe truncates them rather than skipping
  // — the live-run BUG 2). The playback DBs (meshProvisioned:false) are NOT
  // created by R2 provision — their own services create them during launch — so
  // they already EXIST by reset time. Pre-seed them present so the `--with
  // playback --reset` truncate path is exercised (mesh-provisioned DBs are added
  // by the core runner when provision runs their CREATE DATABASE).
  for (const db of ['transcripts_local', 'insights_local', 'chat_local']) seams.provisioned.add(db);

  // Native `--login` seams: a fake devLogin POST (200 + canned Set-Cookies) + a jar
  // capture — so `up --login` mints the native cookie jar with NO real network/fs and
  // NEVER shells up.sh. (Default real seams would make a real POST — must be faked.)
  const poster: CookiePoster = {
    async post(url: string, opts: PostOptions): Promise<PostResult> {
      posts.push({ url, opts });
      return { status: 200, ok: true, setCookies: ['iam_session=jwt; Path=/; HttpOnly'] };
    },
  };
  const jar: JarWriter = { write: (path, contents) => jarWrites.push({ path, contents }) };

  // RECORDING meshExec/dashFs — this suite asserts the readiness gating and the
  // dash prelaunch hook calls, so these override the core battery's silent fakes.
  const meshExec: MeshExec = {
    async ready(container: string): Promise<boolean> {
      meshGated.push(container);
      return true;
    },
  };
  const dashFs: DashFs = {
    existsDir: (p: string) => {
      dashCalls.push(`existsDir:${p}`);
      return true;
    },
    existsFile: () => false,
    remove: (p: string) => dashCalls.push(`remove:${p}`),
    write: (p: string) => dashCalls.push(`write:${p}`),
  };

  // M9 fakes: an all-up-to-date git seam (so auto-pull runs hermetically — no real git
  // spawn) + a no-op vite-clear. Both keep the suite's "nothing spawned" invariant.
  const gitRunner: GitRunner = {
    async statusPorcelain() { return ''; },
    async branchShowCurrent() { return 'main'; },
    async symbolicRefDefault() { return 'main'; },
    async fetch() { return true; },
    async hasUpstream() { return true; },
    async revListCount() { return 0; }, // up to date ⇒ no ff
    async mergeFfOnly() { return true; },
  };
  const viteClear: ViteClear = {
    async clear() { return { removed: [] }; },
  };

  const proto = BaseCommand.prototype as unknown as {
    getMeshExec: () => MeshExec;
    getDashFs: () => DashFs;
    getGitRunner: () => GitRunner;
    getViteClear: () => ViteClear;
    getTunnelMoniker: () => (vendorTunnelSh: string) => Promise<string>;
    getTunnelFleetGen: () => (opts: {
      localFleetPath: string;
      outPath: string;
      tunnelDomain: string;
    }) => string | null;
    getRecordUp: () => (
      plan: import('../../../core/record-plan.js').RecordPlan,
      ctx: { qboardRoot: string },
    ) => Promise<{ ok: boolean; message: string }>;
    getCookiePoster: () => CookiePoster;
    getJarWriter: () => JarWriter;
  };
  // Native `up --login` seams (fake POST + jar capture) — never a real network/fs, never up.sh.
  vi.spyOn(proto, 'getCookiePoster').mockReturnValue(poster);
  vi.spyOn(proto, 'getJarWriter').mockReturnValue(jar);
  // Phase 2: a fixed moniker (never spawn tunnel.sh) + a recording seam that records
  // the resolved RecordPlan (never touches docker/aws).
  vi.spyOn(proto, 'getTunnelMoniker').mockReturnValue(async () => 'testmoniker');
  // Phase: fixed fleek LiveKit creds (never spawn `tunnel.sh aws-profile` / `aws`).
  vi.spyOn(proto, 'getFleekCreds').mockReturnValue(() => ({ key: 'realkey', secret: 'realsecret' }));
  // Phase 2 (BLOCKER-2): a fake fleet-config generator that records the request and
  // echoes the outPath as the generated fleet path (never touches the fs).
  vi.spyOn(proto, 'getTunnelFleetGen').mockReturnValue((opts) => {
    fleetGenCalls.push(opts);
    return opts.outPath;
  });
  vi.spyOn(proto, 'getRecordUp').mockReturnValue(async (plan, ctx) => {
    recordUps.push({ plan, ctx });
    return { ok: true, message: `✓ recording stack up (mode: ${plan.mode})` };
  });
  // Re-spying the core battery's meshExec/dashFs returns the SAME spy —
  // mockReturnValue swaps in the recording fakes without stacking.
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(meshExec);
  vi.spyOn(proto, 'getDashFs').mockReturnValue(dashFs);
  vi.spyOn(proto, 'getGitRunner').mockReturnValue(gitRunner);
  vi.spyOn(proto, 'getViteClear').mockReturnValue(viteClear);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installNativeSeams();
  // silence the command's emit()/log lines in the test output.
  vi.spyOn(BaseCommand.prototype, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack up --only — native partial-stack', () => {
  it('boots the closure natively: mesh make-up, topo-wave launch, native seed (no up.sh)', async () => {
    await StackUp.run(['--only', 'scheduling-api,sessions-api', ...WS], config);

    // launched the full closure in topo order — NOT via up.sh.
    expect(launches.map((s) => s.id)).toEqual([
      'iam-api',
      'programs-api',
      'scheduling-api',
      'sessions-api',
    ]);
    // each launch is `pnpm dev` with resolved env.
    expect(launches[0].command).toBe('pnpm');
    expect(launches[0].args).toEqual(['dev']);

    // mesh: make up ran in <soa>/infra; postgres+redis(via iam-api)+rabbitmq gated (no mongo).
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.cwd).toBe(resolve(SOA_ROOT, 'infra'));
    expect(meshGated).toEqual(['soa-postgres-1', 'soa-redis-1', 'soa-rabbitmq-1']);

    // native seed: roster offline steps ran through the Runner (no up.sh argv).
    const seedRuns = runs.filter((r) => r.command !== 'make');
    expect(seedRuns.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
    expect(seedRuns.some((r) => r.args.includes('db:seed'))).toBe(true);
    // never resolved/ran up.sh.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });

  it('runs the dash prelaunch hook when saga-dash is in the closure', async () => {
    await StackUp.run(['--only', 'saga-dash', ...WS], config);
    expect(launches.some((s) => s.id === 'saga-dash')).toBe(true);
    expect(dashCalls.some((c) => c.startsWith('existsDir:'))).toBe(true);
  });

  it('exits non-zero when a service never becomes healthy (and stops launching the rest)', async () => {
    installNativeSeams(new Set(['iam-api']));
    await expect(
      StackUp.run(['--only', 'scheduling-api', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 1 } });
    // iam-api is the first wave; dependents never launched.
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);
  });

  it('--login mints the NATIVE cookie jar + best-effort vendored browser after bring-up + seed (NO up.sh)', async () => {
    await StackUp.run(['--only', 'iam-api', '--login', ...WS], config);
    // native launch + seed happened …
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);

    // … and login was NATIVE: an origin-checked devLogin POST at the slot-0 iam URL for
    // the default persona, and the Netscape jar written to <stateDir>/cookies.txt.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('http://localhost:3010/trpc/auth.devLogin');
    expect(posts[0]?.opts.origin).toBe('http://localhost:3010');
    expect(posts[0]?.opts.body).toBe('{"identifier":"dev@saga.org","email":"dev@saga.org"}');
    expect(jarWrites).toHaveLength(1);
    expect(jarWrites[0]?.path).toBe('/tmp/sds-synthetic/cookies.txt');
    expect(jarWrites[0]?.contents).toContain('iam_session\tjwt');

    // up.sh was NEVER invoked. The only spawn from the login step is the VENDORED
    // browser-login.mjs (best-effort headful auto-login), never up.sh --login.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    const browserLogin = runs.find((r) => r.command === 'node' && r.args.some((a) => a.endsWith('browser-login.mjs')));
    expect(browserLogin).toBeDefined();
    expect(browserLogin?.args[0]).toContain('vendor');
    expect(browserLogin?.args[0]).not.toContain('tools/synthetic-dev');
    expect(browserLogin?.args).not.toContain('--login');
  });

  it('--login stays GREEN when saga-dash is absent — browser step warn-skipped, jar still minted', async () => {
    // The decoupling-finish blocker regression: saga-dash-absent is a supported state
    // (`up` skips it with a warning), but the browser step's spawn cwd
    // (<saga-dash>/apps/web/dash) wouldn't exist → spawn ENOENT rejected → `up` reddened.
    // The guard must warn-and-skip the browser instead; the headless jar is independent.
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue((dir: string) => !dir.includes('/saga-dash'));

    await expect(StackUp.run(['--only', 'iam-api', '--login', ...WS], config)).resolves.toBeUndefined();

    // the native jar was still minted …
    expect(posts).toHaveLength(1);
    expect(jarWrites).toHaveLength(1);
    // … but the vendored browser was never spawned (warn-skip, not ENOENT).
    expect(runs.some((r) => r.command === 'node' && r.args.some((a) => a.endsWith('browser-login.mjs')))).toBe(false);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });

  it('coach absent + --seed full: coach-pg is NOT planned and the run does not fail', async () => {
    // Report the coach checkout as absent; every other repo present.
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue((dir: string) => !dir.endsWith('/coach'));

    // closure(coach-web) = coach-web + coach-api (COACH, absent) + iam-api (present).
    await expect(
      StackUp.run(['--only', 'coach-web', '--seed', 'full', ...WS], config),
    ).resolves.toBeUndefined();

    // only iam-api launched; the coach pair was skipped (repo not cloned).
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);

    // the seed plan dropped coach-pg — NOTHING ran against the coach-db dir (which
    // would have spawn-crashed on the missing checkout with a real runner).
    expect(runs.some((r) => r.cwd.includes('/coach'))).toBe(false);
    expect(runs.some((r) => r.command === 'pnpm' && r.args.includes('db:seed') && r.cwd.includes('coach-db'))).toBe(
      false,
    );
  });

  it('accepts the --coach repo-override flag (native path, no "Nonexistent flag")', async () => {
    // The per-repo --coach pin must parse; it just pins the COACH checkout path.
    await StackUp.run(['--only', 'iam-api', '--coach', '/some/dir', ...WS], config);
    expect(launches.map((s) => s.id)).toEqual(['iam-api']);
  });

  it('--reset natively truncates the closure DBs (no up.sh), then native seed still runs', async () => {
    await StackUp.run(['--only', 'iam-api', '--reset', ...WS], config);
    // M8 R4: `--reset` is NATIVE now — never delegates to up.sh.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    // TRUNCATE ran as docker-exec psql, preserving _prisma_migrations (the DO block).
    const truncs = runs.filter(
      (r) =>
        r.command === 'docker' &&
        r.args.includes('psql') &&
        r.args.includes('-c') &&
        r.args[r.args.indexOf('-c') + 1].includes("tablename <> '_prisma_migrations'"),
    );
    expect(truncs.length).toBeGreaterThan(0);
    // native seed steps still ran (roster baseline).
    expect(runs.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
  });

  it('--with playback --reset threads withPlayback into the native reset (playback DBs truncated)', async () => {
    // BLOCKER 2: the up-path reset must forward `withPlayback` so `--with playback
    // --reset` also truncates the playback trio (transcripts/insights/chat). Without
    // the thread, resetClosure would skip them (meshProvisioned:false) even though
    // --with playback pulled them into the closure — diverging from up.sh --reset
    // --with-playback and from `stack reset --with playback`.
    await StackUp.run(['--with', 'playback', '--reset', ...WS], config);
    const truncatedDbs = runs
      .filter((r) => r.command === 'docker' && r.args.includes('psql') && r.args.includes('-d'))
      .map((r) => r.args[r.args.indexOf('-d') + 1]);
    expect(truncatedDbs).toContain('transcripts_local');
    expect(truncatedDbs).toContain('insights_local');
    expect(truncatedDbs).toContain('chat_local');
  });
});

describe('stack up --slot N — isolated bring-up (M7 Phase 2)', () => {
  // applyInstanceEnv mutates process.env (SAGA_MESH_*_CONTAINER + SNAPSHOTS_DIR);
  // snapshot + restore the affected keys so a slot run can't leak into siblings.
  const SLOT_ENV_KEYS = [
    'SAGA_MESH_POSTGRES_CONTAINER',
    'SAGA_MESH_REDIS_CONTAINER',
    'SAGA_MESH_RABBITMQ_CONTAINER',
    'SAGA_MESH_MONGO_CONTAINER',
    'SAGA_MESH_CONNECT_MONGO_CONTAINER',
    'SAGA_MESH_SNAPSHOTS_DIR',
  ];
  let savedEnv: EnvSnapshot;

  beforeEach(() => {
    savedEnv = saveEnv(SLOT_ENV_KEYS);
  });
  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('slot > 0 is a backend + saga-dash/coach frontend sub-stack: dash launches on its offset --port; literal-port backends + connect-web dropped', async () => {
    // request the saga-dash frontend + the literal-port playback trio at slot 1:
    // the closure pulls the backend deps; saga-dash now comes up (on its offset
    // port), but every excluded service (literal-port backends + connect-web) is
    // dropped — slot > 0 is a backend + saga-dash/coach frontend sub-stack.
    await StackUp.run(['--only', 'saga-dash', '--with', 'playback', '--slot', '1', ...WS], config);

    const ids = launches.map((s) => s.id);
    // the slot-safe BACKEND deps launched …
    expect(ids).toContain('iam-api');
    expect(ids).toContain('sessions-api');
    expect(ids).toContain('content-api');
    // … and saga-dash is now IN the slot, listening on its offset port via `--port`.
    expect(ids).toContain('saga-dash');
    const dash = launches.find((s) => s.id === 'saga-dash');
    expect(dash?.command).toBe('pnpm');
    expect(dash?.args).toEqual(['dev', '--port', '9900']); // 8900 + slot 1 offset
    // … ads-adm-api is slottable now (tokenized env + EXPRESS_SERVER_PORT
    // injection) and launches in-slot …
    expect(ids).toContain('ads-adm-api');
    // … connect-api is slottable now (soa#271) but is NOT in THIS closure: nothing in
    // `--only saga-dash --with playback` reaches connect-api (saga-dash has no connect-*
    // dependency edge at all). It launches in-slot only when it's actually in the
    // closure — see the bare full-stack --slot 1 test below (non-optional set includes it).
    expect(ids).not.toContain('connect-api');
    // … and the still-un-slottable services are dropped from the slot bring-up:
    // connect-web (a real Connect room needs slot-0-only livekit) …
    expect(ids).not.toContain('connect-web');
    // … and the literal-port backends (bypass the offset).
    expect(ids).not.toContain('transcripts-api');
    expect(ids).not.toContain('insights-api');
    expect(ids).not.toContain('chat-api');

    // mesh came up under the slot project on offset ports.
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.args).toContain('COMPOSE_PROJECT_NAME=soa-s1');
    expect(makeUp?.args).toContain('POSTGRES_PORT=6432');
    expect(makeUp?.env).toMatchObject({ COMPOSE_PROJECT_NAME: 'soa-s1' });
    // readiness gated the slot's containers (env seam applied).
    expect(meshGated.every((c) => c.startsWith('soa-s1-'))).toBe(true);

    // env seam set for the snapshot store + container resolvers.
    expect(process.env.SAGA_MESH_POSTGRES_CONTAINER).toBe('soa-s1-postgres-1');
    expect(process.env.SAGA_MESH_SNAPSHOTS_DIR?.endsWith('/.saga-mesh/snapshots-s1')).toBe(true);
  });

  it('slot > 0 launches saga-dash on its offset --port and WRITES the slot dash config', async () => {
    // saga-dash listens on its offset port now (launch-seam `--port 9900`), so it is
    // included at slot > 0. Its prelaunch hook fires and WRITES config.local.json
    // pointing each dash service at its offset localhost port (not slot 0's).
    await StackUp.run(['--only', 'saga-dash', '--slot', '1', ...WS], config);
    expect(launches.map((s) => s.id)).toContain('saga-dash');
    const dash = launches.find((s) => s.id === 'saga-dash');
    expect(dash?.args).toEqual(['dev', '--port', '9900']); // 8900 + slot 1 offset
    expect(launches.map((s) => s.id)).toContain('iam-api'); // backend dep up too
    // dash prelaunch hook ran and WROTE the offset-port slot config (not removed).
    expect(dashCalls.some((c) => c.startsWith('write:'))).toBe(true);
    // soa#328: the SAME routing JSON also rides saga-dash's OWN launch env, so the
    // slot's dash serves its own /config.local.json without the shared static file.
    const cfg = JSON.parse(dash?.env.DASH_CONFIG_LOCAL_JSON ?? 'null');
    expect(cfg.localDefaults.iam).toEqual({ type: 'url', url: 'http://localhost:4010' }); // 3010 + slot 1 offset
    expect(cfg.localDefaults['ads-adm'].url).not.toContain(':5005'); // never slot 0's ads-adm
    // no other service gets the dash-only var.
    const iam = launches.find((s) => s.id === 'iam-api');
    expect(iam?.env.DASH_CONFIG_LOCAL_JSON).toBeUndefined();
  });

  it('BARE full-stack --slot 1 routes through the NATIVE path (never the up.sh wrapper)', async () => {
    // BLOCKER-1: a bare `up --slot 1` (no --only) must NOT fall through to up.sh
    // (hardcoded project soa / base ports / slot-0 STATE → clobbers slot 0). It is
    // expanded to the full non-optional set and brought up natively as a soa-s1
    // BACKEND sub-stack.
    await StackUp.run(['--slot', '1', ...WS], config);

    // never resolved/ran the up.sh wrapper.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    // launched natively — the backend set + saga-dash/coach frontends + connect-api
    // present; the still-un-slottable services (literal-port backends + connect-web)
    // are not.
    const ids = launches.map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('iam-api');
    expect(ids).toContain('sessions-api');
    expect(ids).toContain('saga-dash'); // frontend now slottable via --port
    expect(ids).toContain('coach-web');
    expect(ids).toContain('ads-adm-api'); // slottable (tokenized env + port injection)
    expect(ids).toContain('connect-api'); // slottable now (soa#271: sessions dial tokenized)
    expect(ids).toContain('connect-web'); // slottable now (soa#271: offset --port + SHARED slot-0 livekit)

    // mesh came up under the slot project on offset ports (soa-s1, +1000).
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.args).toContain('COMPOSE_PROJECT_NAME=soa-s1');
    expect(makeUp?.args).toContain('POSTGRES_PORT=6432');
    expect(makeUp?.env).toMatchObject({ COMPOSE_PROJECT_NAME: 'soa-s1' });
  });

  it('FLIP 1: BARE full-stack at slot 0 routes through the NATIVE path (never up.sh)', async () => {
    // Native-by-default: a bare `stack up` (no --only/--with) at slot 0 now
    // expands to the full non-optional closure and boots it NATIVELY — the same path
    // `--only` uses — instead of shelling out to up.sh.
    await StackUp.run([...WS], config);

    // never resolved/ran the up.sh wrapper.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    // launched the full non-optional closure natively (slot 0 → nothing excluded).
    const ids = launches.map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('iam-api');
    expect(ids).toContain('saga-dash');
    expect(ids).toContain('ads-adm-api'); // literal-port backend present at slot 0
    expect(ids).toContain('connect-api');
    // mesh came up under the DEFAULT project (no slot offset) — base ports.
    const makeUp = runs.find((r) => r.command === 'make');
    expect(makeUp?.args.some((a) => a.startsWith('COMPOSE_PROJECT_NAME=soa-s'))).toBe(false);
    // native roster seed ran (the default profile) — no up.sh.
    expect(runs.some((r) => r.args.some((a) => a.includes('seed-dev-user')))).toBe(true);
  });


  it('BARE full-stack + --sandbox (no --only) hard-errors (--sandbox requires --only; never up.sh)', async () => {
    // Phase 2: --sandbox is NATIVE but must accompany a service set (up.sh constraint).
    await expect(StackUp.run(['--sandbox', 'demo', ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('--sandbox <name> requires --only'),
    });
    expect(launches).toEqual([]);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });

  it('BARE up --tunnel is NATIVE: tunnel_env launch env + vendored tunnel.sh up (never up.sh)', async () => {
    // Phase 2 (saga-ed/soa#214): native `up --tunnel` resolves the moniker (fixed seam),
    // launches every service with the tunnel_env overlay, then runs the VENDORED tunnel.sh
    // up — NO up.sh anywhere.
    await StackUp.run(['--tunnel', ...WS], config);

    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    // iam-api carries the tunnel cookie-domain + CORS tunnel origins (tunnel_env).
    const iam = launches.find((s) => s.id === 'iam-api');
    expect(iam?.env.AUTH_SESSIONCOOKIEDOMAIN).toBe('.testmoniker.vms.wootdev.com');
    expect(iam?.env.CORS_ORIGIN).toContain('https://dash.testmoniker.vms.wootdev.com');
    // connect-web's VITE_* deps flip to the tunnel hosts.
    const cweb = launches.find((s) => s.id === 'connect-web');
    expect(cweb?.env.VITE_IAM_API_URL).toBe('https://iam.testmoniker.vms.wootdev.com');
    expect(cweb?.env.VITE_CONNECTV3_API_URL).toBe('https://connect-api.testmoniker.vms.wootdev.com');
    // the VENDORED tunnel.sh up ran after the launch (not soa's tools/synthetic-dev copy).
    const tun = runs.find((r) => r.command.endsWith('tunnel.sh'));
    expect(tun?.args).toEqual(['up']);
    expect(tun?.command).toContain('vendor');
    // soa#328: saga-dash's launch env carries its own tunnel routing JSON (the same
    // map the file hook writes), so the dash serves per-instance /config.local.json.
    const dash = launches.find((s) => s.id === 'saga-dash');
    const cfg = JSON.parse(dash?.env.DASH_CONFIG_LOCAL_JSON ?? 'null');
    expect(cfg.localDefaults.iam).toEqual({
      type: 'url',
      url: 'https://iam.testmoniker.vms.wootdev.com',
    });
    // … and the launch spec carries the adoptEnv guard on that key: the env now
    // SHADOWS the static file in a new-enough dash, so a mode-drifted already-up
    // dash (e.g. tunnel → plain `up` without a `stack down`) must be refused and
    // relaunched, not adopted with frozen tunnel routing (soa#305 pattern).
    expect(dash?.adoptEnv).toContain('DASH_CONFIG_LOCAL_JSON');
  });

  it('--slot 10 is rejected at the flag layer (rabbitmq-mgmt collision ceiling)', async () => {
    await expect(StackUp.run(['--slot', '10', ...WS], config)).rejects.toThrow(
      /9|less than or equal|cannot be greater/i,
    );
    expect(launches).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('slot 0 launches ads-adm-api and REMOVES the dash config (byte-identical)', async () => {
    await StackUp.run(['--only', 'saga-dash', ...WS], config);
    expect(launches.map((s) => s.id)).toContain('ads-adm-api');
    expect(meshGated.every((c) => !c.startsWith('soa-s1-'))).toBe(true);
    // dash existsFile()=false in the fake ⇒ non-tunnel slot-0 path is a noop-absent
    // (no write). The key assertion: NO stack-slot write happened at slot 0.
    expect(dashCalls.some((c) => c.startsWith('write:'))).toBe(false);
    // soa#328: slot-0 non-tunnel injects NO dash config env — launch env byte-identical.
    const dash = launches.find((s) => s.id === 'saga-dash');
    expect(dash?.env.DASH_CONFIG_LOCAL_JSON).toBeUndefined();
  });

  // NB: these two --login tests are placed at the END of this describe (not by the
  // BARE `--tunnel` test above) on purpose — soa#291 adds its LiveKit-creds tests
  // right after that bare test, so keeping these here avoids an overlay merge
  // conflict between the two tunnel PRs in this shared file.
  it('--tunnel --login: login mints against the PUBLIC tunnel iam + opens the tunnel dash, AFTER the tunnels are up', async () => {
    await StackUp.run(['--tunnel', '--login', ...WS], config);
    const TD = 'testmoniker.vms.wootdev.com';

    // devLogin POSTed at the PUBLIC tunnel iam (not localhost:3010), so the minted
    // iam_session is scoped for the tunnel cookie domain instead of mis-scoped.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`https://iam.${TD}/trpc/auth.devLogin`);

    // the best-effort headful browser targets the tunnel dash + iam (not localhost).
    const browserLogin = runs.find(
      (r) => r.command === 'node' && r.args.some((a) => a.endsWith('browser-login.mjs')),
    );
    expect(browserLogin?.env?.DASH_URL).toBe(`https://dash.${TD}`);
    expect(browserLogin?.env?.IAM_URL).toBe(`https://iam.${TD}`);

    // ORDERING (up.sh: tunnel.sh up → login_user): the tunnels came up BEFORE the
    // login browser step. Both go through runVendor, so compare their run indices.
    const tunIdx = runs.findIndex((r) => r.command.endsWith('tunnel.sh'));
    const browserIdx = runs.findIndex(
      (r) => r.command === 'node' && r.args.some((a) => a.endsWith('browser-login.mjs')),
    );
    expect(tunIdx).toBeGreaterThanOrEqual(0);
    expect(browserIdx).toBeGreaterThan(tunIdx);
  });

  it('--login WITHOUT --tunnel still mints against localhost (tunnel routing is opt-in)', async () => {
    await StackUp.run(['--only', 'iam-api', '--login', ...WS], config);
    expect(posts[0]?.url).toBe('http://localhost:3010/trpc/auth.devLogin');
  });
});

describe('stack up — native Connect AV (#221, M9)', () => {
  /** The AV bring-up compose call the native path fires at slot 0 when connect is present. */
  function avCall(): ScriptInvocation | undefined {
    return runs.find((r) => r.command === 'docker' && r.args.includes('livekit'));
  }

  it('STARTS livekit + coturn from qboard compose when Connect (connect-api) is in the native closure', async () => {
    await StackUp.run(['--only', 'connect-api', ...WS], config);
    expect(launches.map((s) => s.id)).toContain('connect-api');
    const av = avCall();
    expect(av).toBeDefined();
    // `docker compose -f <QBOARD>/docker-compose.yml up -d livekit coturn`.
    expect(av?.args).toEqual(['compose', '-f', resolve(DEV_ROOT, 'qboard', 'docker-compose.yml'), 'up', '-d', 'livekit', 'coturn']);
  });

  it('does NOT start AV when Connect is absent from the native closure (backend path stays quiet)', async () => {
    await StackUp.run(['--only', 'iam-api', ...WS], config);
    expect(launches.map((s) => s.id)).not.toContain('connect-api');
    expect(avCall()).toBeUndefined();
  });

});

describe('stack up --only --dry-run — planner prints the native launch + seed plan', () => {
  it('does NOT touch any seam and emits the seed plan', async () => {
    const logged: string[] = [];
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
      logged.push(String(m ?? ''));
    });
    await StackUp.run(['--only', 'scheduling-api,sessions-api', '--dry-run', ...WS], config);

    expect(launches).toEqual([]);
    expect(runs).toEqual([]);
    const text = logged.join('\n');
    expect(text).toContain('native partial-stack: would launch');
    expect(text).toContain('offline:');
  });

  it('--sandbox surfaces the PRUNED launch set (the sandbox-hosted deps are not launched locally)', async () => {
    const logged: string[] = [];
    vi.spyOn(BaseCommand.prototype, 'log').mockImplementation((m?: string) => {
      logged.push(String(m ?? ''));
    });
    await StackUp.run(['--only', 'sis-api', '--sandbox', 'foo', '--dry-run', ...WS], config);

    expect(launches).toEqual([]);
    expect(runs).toEqual([]);
    const text = logged.join('\n');
    // The dry-run reflects what actually launches: only sis-api locally; iam-api (a
    // pulled-in dep) is HOSTED at the cloud sandbox 'foo' and NOT launched locally.
    expect(text).toContain('launch set (sandbox/workspace prune): sis-api');
    expect(text).toContain('iam-api');
    expect(text).toContain("at sandbox 'foo'");
  });
});

describe('stack up — Phase 2 native --sandbox / --tunnel / --record / --workspace (no up.sh)', () => {
  it('--only sis-api --sandbox foo → native; launches ONLY sis-api (iam lives at the cloud sandbox)', async () => {
    await StackUp.run(['--only', 'sis-api', '--sandbox', 'foo', ...WS], config);

    // never shelled up.sh — the sandbox hybrid is fully native now.
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);

    // BLOCKER-1: the launch set is EXACTLY [sis-api] — iam-api (a pulled-in dep) is NOT
    // launched locally; it lives at the cloud sandbox (sis-api is repointed there below).
    expect(launches.map((s) => s.id)).toEqual(['sis-api']);
    expect(launches.some((s) => s.id === 'iam-api')).toBe(false);

    // sis-api's iam DEP is repointed at the cloud sandbox + it originates the preview header.
    const sis = launches.find((s) => s.id === 'sis-api');
    expect(sis?.env.IAM_BASEURL).toBe('https://iam.wootdev.com/trpc');
    expect(sis?.env.IAM_TOKENURL).toBe('https://iam.wootdev.com/v1/oauth/token');
    expect(sis?.env.PREVIEW_ORIGINATE_MAP).toBe('x-saga-preview-iam-api=sandbox-foo');

    // mesh gate is narrowed to sis-api's own mesh (postgres) — iam-api's deps don't come up.
    expect(meshGated).toEqual(['soa-postgres-1']);
  });

  it('--tunnel → rtsm-api FLEET_CONFIG_PATH points at the GENERATED tunnel fleet (not the localhost fleet)', async () => {
    // BLOCKER-2: `--tunnel` must GENERATE rtsm-fleet-tunnel.json and flip rtsm-api's
    // FLEET_CONFIG_PATH to it, so a remote browser's CRDT discovery resolves a reachable
    // node (else it keeps rtsm-fleet-local.json → localhost:6110 → "no reachable fleet").
    await StackUp.run(['--tunnel', ...WS], config);

    // the fleet-config generator was invoked with the tunnel domain + a *-tunnel.json outPath.
    expect(fleetGenCalls).toHaveLength(1);
    expect(fleetGenCalls[0].tunnelDomain).toBe('testmoniker.vms.wootdev.com');
    expect(fleetGenCalls[0].outPath).toMatch(/\/rtsm-fleet-tunnel\.json$/);
    expect(fleetGenCalls[0].localFleetPath).toMatch(/\/rtsm-fleet-local\.json$/);

    // rtsm-api's resolved launch env carries FLEET_CONFIG_PATH = the generated tunnel
    // fleet (TUNNEL_RTSM_FLEET_PATH populated), NOT the localhost:6110 local fleet.
    const rtsm = launches.find((s) => s.id === 'rtsm-api');
    expect(rtsm?.env.FLEET_CONFIG_PATH).toBe(fleetGenCalls[0].outPath);
    expect(rtsm?.env.FLEET_CONFIG_PATH).toMatch(/\/rtsm-fleet-tunnel\.json$/);
    expect(rtsm?.env.FLEET_CONFIG_PATH).not.toMatch(/rtsm-fleet-local\.json$/);
  });

  it('--tunnel → connect-api signs with the fetched fleek LiveKit creds (real cluster A/V)', async () => {
    // The fleek-creds seam resolved real cluster creds (up.sh's Secrets Manager fetch);
    // connect-api must sign LiveKit tokens with them, not the local dev key, or the
    // fleek cluster rejects the tokens and A/V fails.
    await StackUp.run(['--tunnel', ...WS], config);
    const connectApi = launches.find((s) => s.id === 'connect-api');
    expect(connectApi?.env.LIVEKIT_API_KEY).toBe('realkey');
    expect(connectApi?.env.LIVEKIT_API_SECRET).toBe('realsecret');
    // topology always points browsers at the fleek dev cluster in tunnel mode.
    expect(connectApi?.env.FLEEK_TOPOLOGY_JSON).toContain('fleek.wootdev.com');
  });

  it('--only programs-api --sandbox demo → programs-api gets IAM_API_URL flip + originate (sandbox_env)', async () => {
    await StackUp.run(['--only', 'programs-api', '--sandbox', 'demo', ...WS], config);
    const programs = launches.find((s) => s.id === 'programs-api');
    expect(programs?.env.IAM_API_URL).toBe('https://iam.wootdev.com');
    expect(programs?.env.PREVIEW_ORIGINATE_MAP).toBe('x-saga-preview-iam-api=sandbox-demo');
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });

  it('--sandbox validates the IDENTIFIER shape (rejects bad names before any launch)', async () => {
    await expect(
      StackUp.run(['--only', 'sis-api', '--sandbox', 'BAD NAME!', ...WS], config),
    ).rejects.toMatchObject({ message: expect.stringContaining('must match') });
    expect(launches).toEqual([]);
  });

  it('--only connect-api --record crdt → record plan resolved via the seam (no up.sh)', async () => {
    await StackUp.run(['--only', 'connect-api', '--record', 'crdt', ...WS], config);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    expect(recordUps).toHaveLength(1);
    expect(recordUps[0].plan.mode).toBe('crdt');
    expect(recordUps[0].plan.services).toEqual(['recorder', 'recordings-api', 'minio', 'minio-init']);
    // connect-api still launched natively (the recorder observes it).
    expect(launches.map((s) => s.id)).toContain('connect-api');
  });

  it('--record av adds the LiveKit egress sidecar to the record plan', async () => {
    await StackUp.run(['--only', 'connect-api', '--record', 'av', ...WS], config);
    expect(recordUps).toHaveLength(1);
    expect(recordUps[0].plan.services).toContain('egress');
  });

  it('--record SKIPS with a warning (seam never called) when the fleek repo is not cloned', async () => {
    // fleek dir absent; every other repo present.
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue((dir: string) => !dir.endsWith('/fleek'));

    await StackUp.run(['--only', 'connect-api', '--record', 'crdt', ...WS], config);
    // the record seam was NOT invoked (fleek-absent skip), and no up.sh anywhere.
    expect(recordUps).toEqual([]);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });

  it('--workspace f.json → parses the run-set into a native closure (no up.sh)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-ws-'));
    const file = join(dir, 'ws.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: '1',
        services: { 'iam-api': { mode: 'local-source' }, 'sis-api': { mode: 'local-source' } },
      }),
    );
    await StackUp.run(['--workspace', file, ...WS], config);

    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    const ids = launches.map((s) => s.id);
    expect(ids).toContain('iam-api');
    expect(ids).toContain('sis-api');
  });

  it('--workspace with iam-api sandbox-hosted → sis-api gets the sandbox_env overlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-ws-'));
    const file = join(dir, 'ws.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: '1',
        services: {
          'iam-api': { mode: 'sandbox', sandboxName: 'ws1' },
          'sis-api': { mode: 'local-source' },
        },
      }),
    );
    await StackUp.run(['--workspace', file, ...WS], config);

    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
    const sis = launches.find((s) => s.id === 'sis-api');
    expect(sis?.env.PREVIEW_ORIGINATE_MAP).toBe('x-saga-preview-iam-api=sandbox-ws1');
  });

  it('--workspace rejects a local-image entry (Phase-2 unsupported; never up.sh)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-ws-'));
    const file = join(dir, 'ws.json');
    writeFileSync(
      file,
      JSON.stringify({ version: '1', services: { 'iam-api': { mode: 'local-image' } } }),
    );
    await expect(StackUp.run(['--workspace', file, ...WS], config)).rejects.toMatchObject({
      message: expect.stringContaining('local-image'),
    });
    expect(launches).toEqual([]);
    expect(runs.some((r) => r.command.endsWith('up.sh'))).toBe(false);
  });
});
