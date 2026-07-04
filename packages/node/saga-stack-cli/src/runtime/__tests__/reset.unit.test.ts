/**
 * R4 native-reset unit tests (M8; up.sh:1661-1698 reset_data).
 *
 * Inject a fake Runner + fake container names and assert the generated per-DB
 * reset PLAN: the generic TRUNCATE DO block preserving `_prisma_migrations`, the
 * ledger migrate-reset special case, the connectv3 mongo drop, playback gating on
 * `--with playback`, canonical order, slot-awareness (resolved containers + offset
 * URL), and idempotency. NO real docker/postgres.
 */

import { describe, expect, it } from 'vitest';
import type { DbId } from '../../core/manifest/index.js';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import type { PgProbe } from '../pg-probe.js';
import { mongoDropArgs, resetClosure, truncateSql, truncateArgs } from '../reset.js';

const REPO_ROOTS = {
  SOA: '/dev/soa',
  ROSTERING: '/dev/rostering',
  PROGRAM_HUB: '/dev/program-hub',
  SAGA_DASH: '/dev/saga-dash',
  SDS: '/dev/student-data-system',
  QBOARD: '/dev/qboard',
  RTSM: '/dev/rtsm',
  FLEEK: '/dev/fleek',
  COACH: '/dev/coach',
} as const;

const PG = 'soa-postgres-1';
const MONGO = 'soa-connect-mongo-1';

function fakeRunner(code = 0): { runner: Runner; calls: ScriptInvocation[] } {
  const calls: ScriptInvocation[] = [];
  const runner: Runner = {
    async run(spec): Promise<RunResult> {
      calls.push(spec);
      return { code };
    },
  };
  return { runner, calls };
}

/** A fake PgProbe whose `databaseExists` answers from a set of PRESENT db names. */
function fakeProbe(present: string[]): PgProbe {
  const set = new Set(present);
  return {
    async databaseExists(_c, db): Promise<boolean> {
      return set.has(db);
    },
    async hasMigrationsTable(): Promise<boolean> {
      return false;
    },
    async publicTableCount(): Promise<number> {
      return 0;
    },
    async scalar(): Promise<string> {
      return '';
    },
  };
}

/** The `-c "<sql>"` payload of a `docker exec … psql … -c <sql>` invocation. */
function sqlOf(call: ScriptInvocation): string {
  return call.args[call.args.indexOf('-c') + 1];
}

function baseCtx(dbs: DbId[], overrides: Partial<Parameters<typeof resetClosure>[0]> = {}) {
  const { runner } = fakeRunner();
  return {
    dbs,
    pgContainer: PG,
    mongoContainer: MONGO,
    repoRoots: REPO_ROOTS as unknown as Record<string, string>,
    runner,
    ...overrides,
  } as Parameters<typeof resetClosure>[0];
}

describe('truncateSql / truncateArgs (R4)', () => {
  it('the DO block truncates public tables EXCEPT _prisma_migrations, RESTART IDENTITY CASCADE', () => {
    const sql = truncateSql();
    expect(sql).toContain("schemaname='public'");
    expect(sql).toContain("tablename <> '_prisma_migrations'");
    expect(sql).toContain('RESTART IDENTITY CASCADE');
  });

  it('truncateArgs uses postgres_admin, the target db, and ON_ERROR_STOP', () => {
    const args = truncateArgs(PG, 'programs');
    expect(args.slice(0, 3)).toEqual(['exec', PG, 'psql']);
    expect(args).toContain('-U');
    expect(args[args.indexOf('-U') + 1]).toBe('postgres_admin');
    expect(args[args.indexOf('-d') + 1]).toBe('programs');
    expect(args[args.indexOf('-v') + 1]).toBe('ON_ERROR_STOP=1');
  });

  it('mongoDropArgs drops the named db via getSiblingDB', () => {
    const args = mongoDropArgs(MONGO, 'connectv3');
    expect(args.slice(0, 3)).toEqual(['exec', MONGO, 'mongosh']);
    expect(args[args.indexOf('--eval') + 1]).toBe('db.getSiblingDB("connectv3").dropDatabase()');
  });
});

describe('resetClosure — per-DB reset plan (R4)', () => {
  it('truncates a resetMode:truncate DB preserving _prisma_migrations', async () => {
    const { runner, calls } = fakeRunner();
    const res = await resetClosure(baseCtx(['programs'] as DbId[], { runner }));
    expect(res.ok).toBe(true);
    expect(res.dbs).toEqual([{ db: 'programs', action: 'truncated', ok: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('docker');
    expect(calls[0].args[1]).toBe(PG);
    expect(sqlOf(calls[0])).toBe(truncateSql());
  });

  it('ledger_local takes migrate-reset (prisma migrate reset --force), NOT truncate', async () => {
    const { runner, calls } = fakeRunner();
    const res = await resetClosure(baseCtx(['ledger_local'] as DbId[], { runner }));
    expect(res.dbs).toEqual([{ db: 'ledger_local', action: 'migrate-reset', ok: true }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('pnpm');
    // NO --skip-seed: prisma 7.8.0's `migrate reset` rejects that flag (usage + non-zero
    // exit). ledger-db configures no prisma seed hook, so `--force` alone never seeds.
    expect(calls[0].args).toEqual(['prisma', 'migrate', 'reset', '--force']);
    expect(calls[0].args).not.toContain('--skip-seed');
    // runs in the ledger-db package (the VERIFIED schema owner, owned by the SDS repo —
    // NOT ads-adm-db) with DATABASE_URL at ledger (ledger-db's prisma.config.ts THROWS
    // without it, so the migrate-reset step MUST carry it).
    expect(calls[0].cwd).toBe('/dev/student-data-system/packages/node/ledger-db');
    expect(calls[0].env.DATABASE_URL).toContain('/ledger_local');
    // slot 0: base mesh pg port (no offset).
    expect(calls[0].env.DATABASE_URL).toContain(':5432/ledger_local');
    // no docker truncate for ledger.
    expect(calls.some((c) => c.command === 'docker')).toBe(false);
  });

  it('drops connectv3 on the mongo container (dropDatabase)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await resetClosure(baseCtx(['connectv3'] as DbId[], { runner }));
    expect(res.dbs).toEqual([{ db: 'connectv3', action: 'mongo-dropped', ok: true }]);
    expect(calls[0].args.slice(0, 3)).toEqual(['exec', MONGO, 'mongosh']);
    expect(calls[0].args[calls[0].args.indexOf('--eval') + 1]).toBe(
      'db.getSiblingDB("connectv3").dropDatabase()',
    );
  });

  it('playback DBs are SKIPPED without withPlayback, truncated WITH it', async () => {
    const noPb = fakeRunner();
    const res1 = await resetClosure(baseCtx(['transcripts_local'] as DbId[], { runner: noPb.runner }));
    expect(res1.dbs).toEqual([
      { db: 'transcripts_local', action: 'skipped', ok: true, reason: 'playback DB (needs --with playback)' },
    ]);
    expect(noPb.calls).toHaveLength(0);

    const withPb = fakeRunner();
    const res2 = await resetClosure(
      baseCtx(['transcripts_local'] as DbId[], { runner: withPb.runner, withPlayback: true }),
    );
    expect(res2.dbs).toEqual([{ db: 'transcripts_local', action: 'truncated', ok: true }]);
    expect(withPb.calls).toHaveLength(1);
    expect(withPb.calls[0].args[withPb.calls[0].args.indexOf('-d') + 1]).toBe('transcripts_local');
  });

  it('processes DBs in CANONICAL manifest order (not the arbitrary closure order)', async () => {
    const { runner, calls } = fakeRunner();
    // pass out of order — expect iam_local before programs before connectv3.
    await resetClosure(baseCtx(['connectv3', 'programs', 'iam_local'] as DbId[], { runner }));
    const dbArgOf = (c: ScriptInvocation): string =>
      c.args.includes('mongosh') ? 'connectv3' : c.args[c.args.indexOf('-d') + 1];
    expect(calls.map(dbArgOf)).toEqual(['iam_local', 'programs', 'connectv3']);
  });

  it('slot > 0: truncate targets the slot container + migrate-reset URL uses the offset port', async () => {
    const { runner, calls } = fakeRunner();
    await resetClosure(
      baseCtx(['programs', 'ledger_local'] as DbId[], {
        runner,
        pgContainer: 'soa-s1-postgres-1',
        mongoContainer: 'soa-s1-connect-mongo-1',
        meshOffset: 1000,
      }),
    );
    const trunc = calls.find((c) => c.command === 'docker' && c.args.includes('psql'));
    expect(trunc?.args[1]).toBe('soa-s1-postgres-1');
    const mig = calls.find((c) => c.command === 'pnpm');
    // migrate-reset carries DATABASE_URL at the OFFSET mesh port (5432 + 1000) for ledger.
    expect(mig?.env.DATABASE_URL).toContain(':6432/ledger_local');
  });

  it('probe reports coach_api ABSENT → skipped (not provisioned), no truncate; existing DB truncated; exit 0', async () => {
    const { runner, calls } = fakeRunner();
    // coach_api not provisioned (partial `up` never brought coach up); programs exists.
    const res = await resetClosure(
      baseCtx(['iam_local', 'coach_api', 'programs'] as DbId[], {
        runner,
        probe: fakeProbe(['iam_local', 'programs']),
      }),
    );
    // Absent DB skipped (ok:true), existing DBs truncated — exit stays ok. Results come
    // back in CANONICAL manifest order (iam_local, programs, coach_api), not input order.
    expect(res.ok).toBe(true);
    expect(res.dbs).toEqual([
      { db: 'iam_local', action: 'truncated', ok: true },
      { db: 'programs', action: 'truncated', ok: true },
      { db: 'coach_api', action: 'skipped', ok: true, reason: 'not provisioned' },
    ]);
    // NO truncate was attempted against coach_api.
    const truncatedDbs = calls
      .filter((c) => c.command === 'docker' && c.args.includes('psql'))
      .map((c) => c.args[c.args.indexOf('-d') + 1]);
    expect(truncatedDbs).toEqual(['iam_local', 'programs']);
    expect(truncatedDbs).not.toContain('coach_api');
  });

  it('probe reports an ABSENT migrate-reset DB (ledger_local) → skipped, no prisma run', async () => {
    const { runner, calls } = fakeRunner();
    const res = await resetClosure(
      baseCtx(['ledger_local'] as DbId[], { runner, probe: fakeProbe([]) }),
    );
    expect(res.dbs).toEqual([{ db: 'ledger_local', action: 'skipped', ok: true, reason: 'not provisioned' }]);
    expect(calls).toHaveLength(0); // no `pnpm prisma migrate reset` against an absent DB.
  });

  it('no probe wired ⇒ acts on every DB unconditionally (pre-guard behaviour)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await resetClosure(baseCtx(['coach_api'] as DbId[], { runner }));
    expect(res.dbs).toEqual([{ db: 'coach_api', action: 'truncated', ok: true }]);
    expect(calls).toHaveLength(1);
  });

  it('IDEMPOTENT/safe: an already-empty DB truncate is still a single no-op statement', async () => {
    // A truncate of an empty table set is a no-op in postgres; the plan is the SAME
    // single statement either way — re-running reset is safe.
    const { runner, calls } = fakeRunner();
    await resetClosure(baseCtx(['sessions'] as DbId[], { runner }));
    await resetClosure(baseCtx(['sessions'] as DbId[], { runner }));
    expect(calls).toHaveLength(2);
    expect(sqlOf(calls[0])).toBe(sqlOf(calls[1]));
  });

  it('a per-DB failure warns (ok:false) but does NOT abort the remaining DBs', async () => {
    const { runner, calls } = fakeRunner(1); // every op exits non-zero
    const res = await resetClosure(baseCtx(['iam_local', 'programs'] as DbId[], { runner }));
    expect(res.ok).toBe(false);
    // both DBs still attempted (no early abort — up.sh's per-DB ⚠ warnings).
    expect(res.dbs.map((d) => d.db)).toEqual(['iam_local', 'programs']);
    expect(res.dbs.every((d) => !d.ok)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a full closure resets truncate DBs + ledger + connectv3 in one pass', async () => {
    const { runner } = fakeRunner();
    const res = await resetClosure(
      baseCtx(
        ['iam_local', 'programs', 'coach_api', 'ledger_local', 'connectv3'] as DbId[],
        { runner },
      ),
    );
    expect(res.dbs.map((d) => `${d.db}:${d.action}`)).toEqual([
      'iam_local:truncated',
      'programs:truncated',
      'coach_api:truncated',
      'ledger_local:migrate-reset',
      'connectv3:mongo-dropped',
    ]);
  });
});
