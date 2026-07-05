/**
 * R3 migrate-runner unit tests (M8 native prep pass; up.sh migrate_db 738-755 +
 * chain 1040-1073).
 *
 * Inject a fake Runner + a fake pg probe and assert the per-DB migrate PLAN: the
 * three-way branch selection (managed/empty/unmanaged) for the `db:deploy`
 * targets, the FIXED `prisma migrate deploy` / `prisma db push` steps, canonical
 * manifest order, the `databaseUrlOverride` DATABASE_URL, per-package dedup
 * (ledger_local), and slot-awareness. NO real docker/postgres/pnpm.
 */

import { describe, expect, it } from 'vitest';
import type { DbId, RepoKey } from '../../core/manifest/index.js';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import type { PgProbe } from '../pg-probe.js';
import { migrateClosure } from '../migrate.js';

const REPO_ROOTS = {
  SOA: '/dev/soa',
  ROSTERING: '/dev/rostering',
  PROGRAM_HUB: '/dev/program-hub',
  SAGA_DASH: '/dev/saga-dash',
  COACH: '/dev/coach',
  SDS: '/dev/student-data-system',
  QBOARD: '/dev/qboard',
  RTSM: '/dev/rtsm',
  FLEEK: '/dev/fleek',
} as Record<RepoKey, string>;

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

/** Branch by db: `managed`/`empty`/`unmanaged` (default empty). */
function fakeProbe(state: Partial<Record<string, 'managed' | 'empty' | 'unmanaged'>> = {}): PgProbe {
  return {
    async databaseExists(): Promise<boolean> {
      return true;
    },
    async hasMigrationsTable(_c, db): Promise<boolean> {
      return (state[db] ?? 'empty') === 'managed';
    },
    async publicTableCount(_c, db): Promise<number> {
      const s = state[db] ?? 'empty';
      return s === 'unmanaged' ? 3 : 0; // >0 tables + no _prisma_migrations ⇒ unmanaged
    },
    async scalar(): Promise<string> {
      return '';
    },
  };
}

const PG = 'soa-postgres-1';
const base = { pgContainer: PG, repoRoots: REPO_ROOTS };

describe('migrateClosure — canonical order + the three-way branch (R3)', () => {
  it('iam chain: iam-db FIXED migrate deploy, then iam-pii-db FIXED db push (order + cwd, no URL)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await migrateClosure({
      ...base,
      dbs: ['iam_pii_local', 'iam_local'] as DbId[], // reversed input …
      runner,
      probe: fakeProbe(),
    });

    expect(res.ok).toBe(true);
    // … but executed in CANONICAL manifest order: iam_local before iam_pii_local.
    expect(res.dbs.map((d) => d.db)).toEqual(['iam_local', 'iam_pii_local']);
    expect(calls[0]).toMatchObject({
      command: 'pnpm',
      args: ['prisma', 'migrate', 'deploy'],
      cwd: '/dev/rostering/packages/node/iam-db',
    });
    // BLOCKER-A: iam-db's prisma.config.ts requires DATABASE_URL — injected from the
    // manifest def (no `.env.local` writer natively).
    expect(calls[0].env).toEqual({ DATABASE_URL: 'postgresql://iam:iam@localhost:5432/iam_local' });
    // iam-pii preserved as a `prisma db push` step (up.sh:1042); needs PII_DATABASE_URL.
    expect(calls[1]).toMatchObject({
      command: 'pnpm',
      args: ['prisma', 'db', 'push'],
      cwd: '/dev/rostering/packages/node/iam-pii-db',
    });
    expect(calls[1].env).toEqual({ PII_DATABASE_URL: 'postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local' });
    expect(res.dbs.every((d) => d.branch === 'fixed')).toBe(true);
  });

  it('db:deploy target — managed branch → pnpm db:deploy with the mesh DATABASE_URL', async () => {
    const { runner, calls } = fakeRunner();
    const res = await migrateClosure({
      ...base,
      dbs: ['programs'] as DbId[],
      runner,
      probe: fakeProbe({ programs: 'managed' }),
    });

    expect(res.dbs[0]).toMatchObject({ db: 'programs', branch: 'managed', command: 'pnpm db:deploy' });
    expect(calls[0]).toMatchObject({ command: 'pnpm', args: ['db:deploy'], cwd: '/dev/program-hub/apps/node/programs-api' });
    // databaseUrlOverride forces the mesh :5432 URL (program-hub apps default to :5433).
    expect(calls[0].env.DATABASE_URL).toBe('postgresql://saga_user:password123@localhost:5432/programs');
  });

  it('db:deploy target — EMPTY branch → db:deploy (replay full history, non-destructive)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await migrateClosure({ ...base, dbs: ['content'] as DbId[], runner, probe: fakeProbe({ content: 'empty' }) });
    expect(res.dbs[0].branch).toBe('empty');
    expect(calls[0].args).toEqual(['db:deploy']);
  });

  it('db:deploy target — UNMANAGED branch → prisma migrate reset --force', async () => {
    const { runner, calls } = fakeRunner();
    const res = await migrateClosure({
      ...base,
      dbs: ['scheduling'] as DbId[],
      runner,
      probe: fakeProbe({ scheduling: 'unmanaged' }),
    });
    expect(res.dbs[0].branch).toBe('unmanaged');
    expect(calls[0].args).toEqual(['prisma', 'migrate', 'reset', '--force']);
    expect(calls[0].env.DATABASE_URL).toBe('postgresql://saga_user:password123@localhost:5432/scheduling');
  });

  it('sis_db (db:deploy) carries SIS_DATABASE_URL, not DATABASE_URL; coach_api (override) carries DATABASE_URL', async () => {
    const { runner, calls } = fakeRunner();
    await migrateClosure({
      ...base,
      dbs: ['coach_api', 'sis_db'] as DbId[],
      runner,
      probe: fakeProbe({ coach_api: 'empty', sis_db: 'empty' }),
    });
    // canonical order: coach_api before sis_db.
    const coach = calls.find((c) => c.cwd.includes('coach-db'));
    const sis = calls.find((c) => c.cwd.includes('sis-db'));
    expect(coach?.env.DATABASE_URL).toBe('postgresql://coach_api_app:dev-password-coach-api-app@localhost:5432/coach_api');
    // BLOCKER-A: sis-db's prisma.config.ts reads SIS_DATABASE_URL (not DATABASE_URL),
    // so R3 injects THAT var (= $SIS_DB_URL) — never DATABASE_URL.
    expect(sis?.env).toEqual({ SIS_DATABASE_URL: 'postgresql://sis:sis@localhost:5432/sis_db' });
  });

  it('BLOCKER-A: fresh checkout (no .env.local) — iam/iam_pii/sis migrate carries the injected env var', async () => {
    const { runner, calls } = fakeRunner();
    await migrateClosure({
      ...base,
      dbs: ['iam_local', 'iam_pii_local', 'sis_db'] as DbId[],
      runner,
      probe: fakeProbe({ sis_db: 'empty' }),
    });
    const byCwd = (needle: string) => calls.find((c) => c.cwd.includes(needle));
    expect(byCwd('iam-db')?.env).toEqual({ DATABASE_URL: 'postgresql://iam:iam@localhost:5432/iam_local' });
    expect(byCwd('iam-pii-db')?.env).toEqual({ PII_DATABASE_URL: 'postgresql://iam_pii:iam_pii@localhost:5432/iam_pii_local' });
    expect(byCwd('sis-db')?.env).toEqual({ SIS_DATABASE_URL: 'postgresql://sis:sis@localhost:5432/sis_db' });
  });

  it('BLOCKER-A at slot > 0: the injected env var carries the OFFSET mesh port', async () => {
    const { runner, calls } = fakeRunner();
    await migrateClosure({
      ...base,
      pgContainer: 'soa-s1-postgres-1',
      meshOffset: 1000,
      dbs: ['iam_local', 'sis_db'] as DbId[],
      runner,
      probe: fakeProbe({ sis_db: 'empty' }),
    });
    const byCwd = (needle: string) => calls.find((c) => c.cwd.includes(needle));
    // 5432 + 1000 = 6432 — the slot's offset postgres, not :5432.
    expect(byCwd('iam-db')?.env.DATABASE_URL).toBe('postgresql://iam:iam@localhost:6432/iam_local');
    expect(byCwd('sis-db')?.env.SIS_DATABASE_URL).toBe('postgresql://sis:sis@localhost:6432/sis_db');
  });

  it('ads_adm_local migrates; ledger_local is SKIPPED (migrate-reset target, not a prep-migrate)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await migrateClosure({
      ...base,
      dbs: ['ads_adm_local', 'ledger_local'] as DbId[],
      runner,
      probe: fakeProbe(),
    });
    // ads_adm_local migrated (FIXED prisma migrate deploy); ledger_local skipped —
    // up.sh never prep-migrates ledger (its schema is (re)built by the R4 reset).
    expect(res.dbs.find((d) => d.db === 'ads_adm_local')?.branch).toBe('fixed');
    const ledger = res.dbs.find((d) => d.db === 'ledger_local');
    expect(ledger?.branch).toBeNull();
    expect(ledger?.skipped).toMatch(/migrate-reset target/);
    // exactly ONE migrate ran, in the ads-adm-db package (ledger-db is NOT prep-migrated).
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/dev/student-data-system/packages/node/ads-adm-db');
  });

  it('skips mongo (connectv3) and playback DBs (not mesh-provisioned)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await migrateClosure({
      ...base,
      dbs: ['connectv3', 'transcripts_local'] as DbId[],
      runner,
      probe: fakeProbe(),
    });
    expect(res.dbs.map((d) => d.branch)).toEqual([null, null]);
    expect(calls).toHaveLength(0);
  });

  it('idempotent re-up: all db:deploy DBs managed ⇒ every branch is `db:deploy` (apply-pending, no reset)', async () => {
    const { runner, calls } = fakeRunner();
    const dbs = ['programs', 'scheduling', 'sessions', 'content'] as DbId[];
    const res = await migrateClosure({
      ...base,
      dbs,
      runner,
      probe: fakeProbe({ programs: 'managed', scheduling: 'managed', sessions: 'managed', content: 'managed' }),
    });
    expect(res.dbs.every((d) => d.branch === 'managed')).toBe(true);
    expect(calls.every((c) => c.args.join(' ') === 'db:deploy')).toBe(true); // never the destructive reset
  });

  it('slot > 0: probe hits the slot container; DATABASE_URL port is offset', async () => {
    const { runner, calls } = fakeRunner();
    await migrateClosure({
      ...base,
      pgContainer: 'soa-s1-postgres-1',
      meshOffset: 1000,
      dbs: ['programs'] as DbId[],
      runner,
      probe: fakeProbe({ programs: 'empty' }),
    });
    // DATABASE_URL points at the slot's offset mesh port (5432 + 1000).
    expect(calls[0].env.DATABASE_URL).toBe('postgresql://saga_user:password123@localhost:6432/programs');
  });

  it('a failed migrate stops the pass with ok:false + the failing db', async () => {
    const { runner } = fakeRunner(1);
    const res = await migrateClosure({
      ...base,
      dbs: ['iam_local', 'iam_pii_local'] as DbId[],
      runner,
      probe: fakeProbe(),
    });
    expect(res.ok).toBe(false);
    expect(res.failed).toBe('iam_local');
  });
});
