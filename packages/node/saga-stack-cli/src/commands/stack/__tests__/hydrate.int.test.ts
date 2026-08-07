/**
 * `stack hydrate` integration tests — in-process (`Config.load(PKG_ROOT)` +
 * `StackHydrate.run(argv, config)`), with every seam that could touch the real
 * world faked on `BaseCommand.prototype`:
 *
 *   - `getHydrateIO`  — the ONLY docker spawn site; records every argv and the
 *     secret it was (or was not) handed.
 *   - `getEnvAws`     — AWS: canned SSM parameters, the master secret, the jump
 *     host lookup, and a fake port-forward whose open/close is recorded.
 *   - `getPgProbe`    — local database existence.
 *   - `getConfirm` / `getClaimReader` / `getClaimWriter` — the guard seams.
 *
 * Everything pushes into ONE ordered `events` list so ordering claims (tunnel
 * opened → work → tunnel closed) are a single assertion.
 *
 * Covers the required pins: a preview run writes NOTHING (and makes no AWS
 * call); slot 0 and a repointed container are refused; real mode maps
 * `users_real` → `users`; scrubbed mode materialises the view and never leaves
 * one; the master password appears in no argv and no output; the tunnel is torn
 * down on the FAILURE path too; grants land so the service role can write; and
 * a verification failure fails the database without touching the live one.
 */

import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreEnv, saveEnv } from '../../../__tests__/helpers/env.js';
import { spySetStore, spySlotActive } from '../../../__tests__/helpers/set-fakes.js';
import { BaseCommand } from '../../../base-command.js';
import { INSTANCE_ENV_KEYS } from '../../../core/derive-instance.js';
import { DEFAULT_LOCAL_PORT, findByMirrorName, planHydrate } from '../../../core/mirror/index.js';
import type {
  ClaimReadResult,
  ClaimWriteInput,
  ConfirmSeam,
  HydrateExecResult,
  HydrateIO,
  PgProbe,
  PortForwardHandle,
  PortForwardRequest,
} from '../../../runtime/index.js';
import StackHydrate from '../hydrate.js';

// Direct in-process runs bypass oclif's plugin loader (which stamps `static id`);
// pin the real id so refusal text / the claim's command line match production.
StackHydrate.id = 'stack:hydrate';

const PKG_ROOT = process.cwd();
const WS = ['--dev', '/fixed/dev'];
const STATE_S2 = '/tmp/sds-synthetic-s2';

/** The mirror master password — must never reach argv or stdout. */
const SECRET = 'sup3r-s3cret-mirror-pw';

let config: Config;
let savedEnv: ReturnType<typeof saveEnv>;
let events: string[];
let out: string[];
let warnings: string[];
let prompts: string[];
let claimWrites: ClaimWriteInput[];
/** Every `docker` argv the executor asked for, with the secret it was handed. */
let execs: { argv: string[]; secret?: string }[];
let portForwards: PortForwardRequest[];
let awsCalls: string[][];

/** Scripted exec answers, keyed by a substring of the joined argv (first match wins). */
let execScript: { match: string; result: Partial<HydrateExecResult> }[];

/**
 * The "everything is healthy" answers for the planner's assertion steps, so a
 * test only has to script the ONE thing it is about. These are the values a good
 * hydrate produces: the staging database is non-empty, no table is unwritable by
 * the service role, and no app-named relation is still a view.
 */
function healthyAnswer(joined: string): string {
  if (joined.includes('(count(*) > 0)')) return 't'; // verify-restored
  if (joined.includes('has_table_privilege')) return '0'; // verify-writable
  if (joined.includes("relkind NOT IN ('r', 'p')")) return '0'; // verify-tables
  return '';
}

function installHydrateIO(): void {
  const io: HydrateIO = {
    async exec(argv, opts): Promise<HydrateExecResult> {
      execs.push({ argv, secret: opts?.secret });
      events.push(`exec:${argv.join(' ')}`);
      const joined = argv.join(' ');
      const scripted = execScript.find((s) => joined.includes(s.match));
      return { code: 0, stdout: healthyAnswer(joined), stderr: '', ...(scripted?.result ?? {}) };
    },
    async assertPgRunning(container): Promise<void> {
      events.push(`assert-pg:${container}`);
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getHydrateIO: () => HydrateIO }, 'getHydrateIO').mockReturnValue(io);
}

/** Canned AWS: SSM params, the master secret, the jump host, and a recorded tunnel. */
function installEnvAws(opts: { readyRejects?: Error } = {}): void {
  const fake = {
    async json(args: string[]): Promise<unknown> {
      awsCalls.push(args);
      events.push(`aws:${args.slice(0, 2).join(' ')}`);
      if (args[0] === 'sts') return '396913734878';
      if (args[0] === 'ssm' && args[1] === 'get-parameter') {
        const name = args[args.indexOf('--name') + 1];
        if (name?.endsWith('/endpoint')) return 'saga-postgres-mirror-current.abc.us-west-2.rds.amazonaws.com';
        if (name?.endsWith('/port')) return '5432';
        if (name?.endsWith('/master-secret-arn')) return 'arn:aws:secretsmanager:us-west-2:396913734878:secret:mirror';
        return null;
      }
      if (args[0] === 'secretsmanager') return JSON.stringify({ username: 'saga_admin', password: SECRET });
      if (args[0] === 'ec2') return ['i-08043e16658b208cc'];
      if (args[0] === 'ssm' && args[1] === 'describe-instance-information') return ['i-08043e16658b208cc'];
      return null;
    },
    async lambdaInvoke(): Promise<unknown> {
      throw new Error('hydrate must never invoke a lambda');
    },
    portForward(req: PortForwardRequest): PortForwardHandle {
      portForwards.push(req);
      events.push(`tunnel-open:${req.target}->${req.host}:${req.remotePort}@${req.localPort}`);
      let resolveExit: (code: number | null) => void = () => undefined;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const ready = opts.readyRejects === undefined ? Promise.resolve() : Promise.reject(opts.readyRejects);
      ready.catch(() => undefined);
      return {
        pid: 4242,
        ready,
        exited,
        stop: () => {
          events.push('tunnel-close');
          resolveExit(0);
        },
      };
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getEnvAws: () => unknown }, 'getEnvAws').mockReturnValue(fake);
}

function installPgProbe(existing: string[]): void {
  const probe: PgProbe = {
    databaseExists: async (_c, db) => existing.includes(db),
    hasMigrationsTable: async () => true,
    publicTableCount: async () => 10,
    scalar: async () => '',
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getPgProbe: () => PgProbe }, 'getPgProbe').mockReturnValue(probe);
}

function installConfirm(answer: boolean): void {
  const confirm: ConfirmSeam = {
    isTTY: () => true,
    async prompt(question: string): Promise<boolean> {
      prompts.push(question);
      return answer;
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getConfirm: () => ConfirmSeam }, 'getConfirm').mockReturnValue(confirm);
}

function installClaimReader(byStateDir: Record<string, ClaimReadResult> = {}): void {
  vi.spyOn(BaseCommand.prototype as unknown as { getClaimReader: () => unknown }, 'getClaimReader').mockReturnValue({
    read: (stateDir: string) => byStateDir[stateDir] ?? null,
  });
}

function claimResult(live: boolean): ClaimReadResult {
  return {
    live,
    claim: {
      version: 1,
      actor: 'someone-else',
      actorSource: 'env',
      pid: 41234,
      command: 'ss stack:up --slot 2',
      at: '2026-08-06T09:00:00.000Z',
      cwd: '/home/x',
      slot: 2,
      sourceAtLaunch: {},
    },
  };
}

/**
 * Build the mirror-side discovery read's stdout: unit-separator-delimited
 * `base<US>column` rows in attnum order — exactly what `psql -A -t -F <US>`
 * produces, so the parser is exercised on its real input shape.
 */
const rows = (pairs: readonly (readonly [string, string])[]): string =>
  pairs.map(([t, c]) => `${t}\u001f${c}`).join('\n') + '\n';

/** All argv the executor ran, flattened — the "is the secret anywhere?" surface. */
const allArgv = (): string => execs.map((e) => e.argv.join(' ')).join('\n');

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  savedEnv = saveEnv(INSTANCE_ENV_KEYS);
  for (const k of INSTANCE_ENV_KEYS) delete process.env[k];
  events = [];
  out = [];
  warnings = [];
  prompts = [];
  claimWrites = [];
  execs = [];
  portForwards = [];
  awsCalls = [];
  execScript = [];
  BaseCommand.resetSlotClaimLatchForTests();
  vi.spyOn(BaseCommand.prototype as unknown as { log: (m?: string) => void }, 'log').mockImplementation((m?: string) => {
    out.push(String(m ?? ''));
  });
  vi.spyOn(BaseCommand.prototype as unknown as { warn: (m: string) => string }, 'warn').mockImplementation(
    (m: string) => {
      warnings.push(String(m));
      return m;
    },
  );
  vi.spyOn(BaseCommand.prototype as unknown as { getClaimWriter: () => unknown }, 'getClaimWriter').mockReturnValue({
    async write(inputRec: ClaimWriteInput): Promise<void> {
      claimWrites.push(inputRec);
    },
  });
  vi.spyOn(BaseCommand.prototype as unknown as { getRunner: () => unknown }, 'getRunner').mockReturnValue({
    async run(): Promise<{ code: number }> {
      return { code: 0 };
    },
  });
  // Instant retries — the rename step's backoff must not cost wall-clock time.
  vi.spyOn(BaseCommand.prototype as unknown as { getSleep: () => unknown }, 'getSleep').mockReturnValue(
    async () => undefined,
  );
  spySetStore({ version: 1, sets: {} });
  spySlotActive([]);
  installClaimReader();
  installHydrateIO();
  installEnvAws();
  installPgProbe(['iam_local', 'coach_api', 'iam_pii_local']);
  installConfirm(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(savedEnv);
});

describe('refusals — non-zero exit, nothing executed', () => {
  it('a bare invocation (slot 0 by default) is refused with a pointer to cold-start', async () => {
    await expect(StackHydrate.run([...WS], config)).rejects.toThrow(/--slot 1\.\.9 or --set/);
    expect(events).toEqual([]);
    expect(execs).toEqual([]);
  });

  it('an explicit --slot 0 is refused the same way, even with --execute --yes', async () => {
    await expect(StackHydrate.run(['--slot', '0', '--execute', '--yes', ...WS], config)).rejects.toThrow(/cold-start/);
    expect(events).toEqual([]);
  });

  it('refuses a NON-LOCAL target: a repointed $SAGA_MESH_POSTGRES_CONTAINER is not obeyed', async () => {
    process.env.SAGA_MESH_POSTGRES_CONTAINER = 'prod-postgres-1';
    await expect(StackHydrate.run(['--slot', '2', '--execute', '--yes', ...WS], config)).rejects.toThrow(
      /must be 'soa-s2-postgres-1'/,
    );
    expect(execs).toEqual([]);
  });

  it('rejects an unknown --db rather than hydrating a smaller set than asked for', async () => {
    await expect(StackHydrate.run(['--slot', '2', '--db', 'programs_db', ...WS], config)).rejects.toThrow(
      /unknown --db 'programs_db'/,
    );
  });

  it('refuses under another driver’s LIVE claim; --yes overrides', async () => {
    installClaimReader({ [STATE_S2]: claimResult(true) });
    await expect(StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', ...WS], config)).rejects.toThrow(
      /someone-else[\s\S]*still running/,
    );
    expect(execs).toEqual([]);

    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...WS], config),
    ).resolves.toBeUndefined();
    expect(execs.length).toBeGreaterThan(0);
  });

  it('a declined prompt aborts (exit 0) having executed nothing', async () => {
    installConfirm(false);
    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', ...WS], config),
    ).resolves.toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(execs).toEqual([]);
    expect(events).toEqual([]);
    expect(out.join('\n')).toContain('hydrate aborted — nothing changed.');
  });
});

describe('preview (the default) — writes nothing, and never even calls AWS', () => {
  it('prints the replacement map and executes nothing: no docker, no AWS, no tunnel, no claim', async () => {
    await expect(StackHydrate.run(['--slot', '2', ...WS], config)).resolves.toBeUndefined();

    const text = out.join('\n');
    expect(text).toContain('PREVIEW');
    expect(text).toContain('iam_db');
    expect(text).toContain('iam_local');
    expect(text).toContain('coach_api');
    expect(text).toMatch(/scheduling_api\s+→ scheduling/);

    expect(execs).toEqual([]);
    expect(awsCalls).toEqual([]);
    expect(portForwards).toEqual([]);
    expect(prompts).toEqual([]);
    // The central claim hook is suppressed by --dry-run only; hydrate's `--execute`
    // latch must produce the same "a preview mutates nothing" guarantee.
    expect(claimWrites).toHaveLength(0);
  });

  it('names what can never be hydrated instead of silently skipping it', async () => {
    await StackHydrate.run(['--slot', '2', ...WS], config);
    const text = out.join('\n');
    expect(text).toContain('connectv3');
    expect(text).toContain('insights_local');
  });
});

describe('--execute — the happy path', () => {
  const argvFor = (extra: string[] = []): string[] => ['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...extra, ...WS];

  it('opens the tunnel, does the work, and closes the tunnel — in that order', async () => {
    await expect(StackHydrate.run(argvFor(), config)).resolves.toBeUndefined();

    const open = events.findIndex((e) => e.startsWith('tunnel-open:'));
    const close = events.indexOf('tunnel-close');
    const firstExec = events.findIndex((e) => e.startsWith('exec:'));
    expect(open).toBeGreaterThanOrEqual(0);
    expect(firstExec).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(firstExec);
    expect(events).toContain('assert-pg:soa-s2-postgres-1');
    // The advisory claim was recorded on entry (an executing hydrate drives the slot).
    expect(claimWrites).toHaveLength(1);
    expect(claimWrites[0]!.slot).toBe(2);
  });

  it('resolves the mirror at RUN TIME from SSM + Secrets Manager (never a stored endpoint)', async () => {
    await StackHydrate.run(argvFor(), config);
    const params = awsCalls.filter((a) => a[0] === 'ssm' && a[1] === 'get-parameter').map((a) => a[a.indexOf('--name') + 1]);
    expect(params).toEqual([
      '/mirror/current/postgres-rds/endpoint',
      '/mirror/current/postgres-rds/port',
      '/mirror/current/postgres-rds/master-secret-arn',
    ]);
    expect(awsCalls.some((a) => a[0] === 'secretsmanager')).toBe(true);
    expect(portForwards[0]).toMatchObject({
      host: 'saga-postgres-mirror-current.abc.us-west-2.rds.amazonaws.com',
      remotePort: 5432,
      localPort: 15532,
      target: 'i-08043e16658b208cc',
    });
  });

  it('creates a staging database, transfers, verifies, and only then renames the live one away', async () => {
    await StackHydrate.run(argvFor(), config);
    const joined = execs.map((e) => e.argv.join(' '));
    const at = (needle: string): number => joined.findIndex((a) => a.includes(needle));

    expect(at('CREATE DATABASE "coach_api__hydrate"')).toBeGreaterThanOrEqual(0);
    expect(at('pg_restore')).toBeGreaterThan(at('CREATE DATABASE "coach_api__hydrate"'));
    expect(at('has_table_privilege')).toBeGreaterThan(at('pg_restore'));
    expect(at('ALTER DATABASE "coach_api" RENAME TO')).toBeGreaterThan(at('has_table_privilege'));
    expect(at('ALTER DATABASE "coach_api__hydrate" RENAME TO "coach_api"')).toBeGreaterThan(
      at('ALTER DATABASE "coach_api" RENAME TO'),
    );
  });

  it('applies grants so the SERVICE ROLE — not just postgres_admin — can write', async () => {
    await StackHydrate.run(argvFor(), config);
    const joined = allArgv();
    expect(joined).toContain('--no-owner');
    expect(joined).toContain('--no-privileges');
    expect(joined).toContain('GRANT ALL ON ALL TABLES IN SCHEMA public TO "coach_api_app";');
    expect(joined).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "coach_api_app";');
    expect(joined).toContain(`has_table_privilege('coach_api_app', c.oid, 'INSERT')`);
  });

  it('skips the retire step for a local database that does not exist yet', async () => {
    installPgProbe([]); // nothing local yet
    await StackHydrate.run(argvFor(), config);
    const joined = allArgv();
    expect(joined).not.toContain('ALTER DATABASE "coach_api" RENAME TO');
    expect(joined).toContain('ALTER DATABASE "coach_api__hydrate" RENAME TO "coach_api"');
  });

  it('--keep-previous keeps the displaced database instead of dropping it', async () => {
    await StackHydrate.run(argvFor(['--keep-previous']), config);
    const joined = allArgv();
    expect(joined).toMatch(/ALTER DATABASE "coach_api__pre_hydrate_\d{8}T\d{6}Z" WITH ALLOW_CONNECTIONS true/);
    expect(joined).not.toMatch(/DROP DATABASE IF EXISTS "coach_api__pre_hydrate_/);
  });
});

describe('the mirror master password never leaks', () => {
  it('appears in NO argv — it is handed to the child env only, via a bare -e PGPASSWORD', async () => {
    await StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...WS], config);

    expect(execs.length).toBeGreaterThan(0);
    expect(allArgv()).not.toContain(SECRET);
    const transfer = execs.find((e) => e.argv.join(' ').includes('pg_dump'))!;
    expect(transfer.secret).toBe(SECRET);
    expect(transfer.argv).toContain('-e');
    expect(transfer.argv[transfer.argv.indexOf('-e') + 1]).toBe('PGPASSWORD');
  });

  it('appears in NO output — not in the human log, not in --output-json', async () => {
    await StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...WS], config);
    expect(out.join('\n')).not.toContain(SECRET);
    expect(warnings.join('\n')).not.toContain(SECRET);

    out = [];
    await StackHydrate.run(
      ['--slot', '2', '--db', 'coach_api', '--execute', '--yes', '--output-json', ...WS],
      config,
    );
    expect(out.join('\n')).not.toContain(SECRET);
  });

  it('is NOT handed to purely-local statements — only the mirror-facing steps get it', async () => {
    await StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...WS], config);
    for (const e of execs) {
      if (e.argv[0] === 'exec') expect(e.secret, e.argv.join(' ')).toBeUndefined();
    }
  });
});

describe('--source real — the _real table becomes the app-named table', () => {
  it('drops the scramble view and renames users_real → users, using the LIVE enumeration', async () => {
    // The mirror-side discovery read answers with two scrubbed tables.
    execScript = [
      {
        match: 'left(c.relname',
        result: {
          stdout: rows([
            ['users', 'id'],
            ['users', 'email'],
            ['groups', 'id'],
          ]),
        },
      },
    ];
    await StackHydrate.run(['--slot', '2', '--db', 'iam_db', '--execute', '--yes', ...WS], config);

    const joined = allArgv();
    expect(joined).toContain('DROP VIEW IF EXISTS public."users" CASCADE; ALTER TABLE public."users_real" RENAME TO "users";');
    expect(joined).toContain('ALTER TABLE public."groups_real" RENAME TO "groups"');
    // real mode takes the data as-is: no exclusion, no COPY of the scrambled view.
    expect(joined).not.toContain('--exclude-table-data');
    expect(joined).not.toContain('TO STDOUT');
  });
});

describe('--source scrubbed — materialises the view, never leaves one', () => {
  beforeEach(() => {
    execScript = [
      {
        match: 'left(c.relname',
        result: {
          stdout: rows([
            ['users', 'id'],
            ['users', 'email'],
          ]),
        },
      },
    ];
  });

  // The scrubbed PATH is built and unit-tested at the planner level, but the
  // command refuses to RUN it: review confirmed two defects unique to this mode
  // — emptying the `_real` tables breaks incoming FKs from tables that do carry
  // data, and the materialising COPY steps are emitted alphabetically rather
  // than FK-topologically. Both abort inside the staging database (the live copy
  // is never at risk), but an operator should not have to discover that.
  // Delete this refusal, and re-enable the three behavioural tests below it,
  // once the ordering is fixed — required before public release.
  it('REFUSES to run, naming both defects and pointing at --source real', async () => {
    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'iam_db', '--source', 'scrubbed', '--execute', '--yes', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 2 } });
  });

  it('refuses BEFORE doing any work — no tunnel, no docker, nothing spawned', async () => {
    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'iam_db', '--source', 'scrubbed', '--execute', '--yes', ...WS], config),
    ).rejects.toBeTruthy();
    expect(allArgv()).toBe('');
  });

  it('the planner still models the mode correctly (kept alive for when the gate lifts)', () => {
    const plan = planHydrate({
      slot: 2,
      mode: 'scrubbed',
      selection: [findByMirrorName('iam_db')!],
      pgContainer: 'soa-s2-postgres-1',
      localPort: 7432,
      mirrorLocalPort: DEFAULT_LOCAL_PORT,
      localExists: { iam_local: true },
      realTables: { iam_db: [{ table: 'users', columns: ['id', 'email'] }] },
      stamp: '20260806T133000Z',
    });
    const joined = JSON.stringify(plan);
    expect(joined).toContain('--exclude-table-data=public.users_real');
    expect(joined).toContain('ALTER TABLE public.\\"users_real\\" RENAME TO \\"users\\"');
    expect(joined).toContain('relkind NOT IN');
  });
});

describe('the tunnel is torn down on EVERY path', () => {
  it('closes it after a successful run', async () => {
    await StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...WS], config);
    expect(events.filter((e) => e === 'tunnel-close')).toHaveLength(1);
    expect(events[events.length - 1]).toBe('tunnel-close');
  });

  it('closes it when the work THROWS mid-restore (the soa#370 orphan-listener failure mode)', async () => {
    // A hard discovery failure inside the try block, after the tunnel is open.
    execScript = [{ match: 'left(c.relname', result: { code: 1, stderr: 'connection reset' } }];
    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'iam_db', '--execute', '--yes', ...WS], config),
    ).rejects.toThrow(/could not enumerate/);
    expect(events).toContain('tunnel-close');
  });

  it('closes it when the tunnel itself never becomes ready', async () => {
    installEnvAws({ readyRejects: new Error('port-forward not ready after 30s') });
    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', ...WS], config),
    ).rejects.toThrow(/not ready/);
    expect(events).toContain('tunnel-close');
    expect(execs.filter((e) => e.argv[0] === 'run')).toEqual([]); // no transfer ever started
  });
});

describe('reporting', () => {
  it('emits the whole report before exiting non-zero on a per-database failure', async () => {
    execScript = [{ match: 'has_table_privilege', result: { stdout: '3' } }];
    await expect(
      StackHydrate.run(['--slot', '2', '--db', 'coach_api', '--execute', '--yes', '--output-json', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 1 } });

    const text = out.join('\n');
    const json = JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown>;
    expect(json.slot).toBe(2);
    expect(json.mode).toBe('real');
    expect(json.failed).toBe('coach_api');
    expect(JSON.stringify(json.databases)).toMatch(/NOT writable by coach_api_app/);
  });

  it('porcelain output stays scalar (no [object Object] rows)', async () => {
    await StackHydrate.run(
      ['--slot', '2', '--db', 'coach_api', '--execute', '--yes', '--porcelain', ...WS],
      config,
    );
    const kv = out.filter((l) => l.includes('='));
    expect(kv.some((l) => l === 'hydrated=coach_api')).toBe(true);
    expect(kv.some((l) => l === 'failed=')).toBe(true);
    expect(out.join('\n')).not.toContain('[object Object]');
  });
});
