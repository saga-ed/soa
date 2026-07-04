/**
 * R2 provisioning-fallback unit tests (M8 native prep pass; up.sh:1048-1068).
 *
 * Inject a fake Runner + a fake pg probe and assert the generated psql PLAN per
 * closure DB: the role `DO` block + a SEPARATE `CREATE DATABASE` (coach_api's new
 * role included), the pg_database existence guard (idempotent no-op), the mongo /
 * playback skips, and slot-awareness (the resolved pg container). NO real docker.
 */

import { describe, expect, it } from 'vitest';
import { manifest } from '../../core/manifest/index.js';
import type { DbId } from '../../core/manifest/index.js';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import type { PgProbe } from '../pg-probe.js';
import { createDatabaseSql, ensureRoleSql, provisionDbs } from '../provision.js';

/** A Runner that records the invocation and returns a canned code. */
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

/** A probe where `exists[db]` decides databaseExists (default: absent). */
function fakeProbe(exists: Partial<Record<string, boolean>> = {}): PgProbe {
  return {
    async databaseExists(_c, db): Promise<boolean> {
      return exists[db] ?? false;
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

/** Extract the `-c "<sql>"` payload from a `docker exec … psql … -c <sql>` invocation. */
function sqlOf(call: ScriptInvocation): string {
  const i = call.args.indexOf('-c');
  return call.args[i + 1];
}

const PG = 'soa-postgres-1';

describe('provisionDbs — idempotent role+DB fallback (R2)', () => {
  it('an ABSENT DB creates its role (DO block) then CREATE DATABASE — SEPARATE statements', async () => {
    const { runner, calls } = fakeRunner();
    const res = await provisionDbs({
      dbs: ['coach_api'] as DbId[],
      pgContainer: PG,
      runner,
      probe: fakeProbe(), // absent
    });

    expect(res.ok).toBe(true);
    expect(res.dbs).toEqual([{ db: 'coach_api', action: 'created' }]);
    // TWO separate docker-exec psql invocations (CREATE DATABASE can't be in the DO/txn).
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.command).toBe('docker');
      expect(c.args.slice(0, 3)).toEqual(['exec', PG, 'psql']);
      expect(c.args.slice(3, 7)).toEqual(['-U', 'postgres_admin', '-d', 'postgres']);
    }
    // statement 1: ensure the coach_api_app role (NEW role, up.sh:1067).
    expect(sqlOf(calls[0])).toBe(ensureRoleSql('coach_api_app', 'dev-password-coach-api-app'));
    expect(sqlOf(calls[0])).toContain("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='coach_api_app')");
    // statement 2: CREATE DATABASE … OWNER (separate).
    expect(sqlOf(calls[1])).toBe(createDatabaseSql('coach_api', 'coach_api_app'));
    expect(sqlOf(calls[1])).toBe('CREATE DATABASE coach_api OWNER coach_api_app');
  });

  it('an EXISTING DB is a no-op (idempotent) — zero psql statements', async () => {
    const { runner, calls } = fakeRunner();
    const res = await provisionDbs({
      dbs: ['sessions', 'content', 'coach_api'] as DbId[],
      pgContainer: PG,
      runner,
      probe: fakeProbe({ sessions: true, content: true, coach_api: true }),
    });

    expect(res.ok).toBe(true);
    expect(res.dbs.map((d) => d.action)).toEqual(['exists', 'exists', 'exists']);
    expect(calls).toHaveLength(0); // a re-up on a provisioned stack runs nothing
  });

  it('creates only the ABSENT DBs (sessions/content present, coach_api missing)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await provisionDbs({
      dbs: ['sessions', 'content', 'coach_api'] as DbId[],
      pgContainer: PG,
      runner,
      probe: fakeProbe({ sessions: true, content: true }), // coach_api absent
    });

    expect(res.dbs.map((d) => d.action)).toEqual(['exists', 'exists', 'created']);
    // only coach_api → 2 statements (role + db).
    expect(calls).toHaveLength(2);
    expect(sqlOf(calls[1])).toBe('CREATE DATABASE coach_api OWNER coach_api_app');
  });

  it('skips mongo (connectv3) and the playback trio (not mesh-provisioned)', async () => {
    const { runner, calls } = fakeRunner();
    const res = await provisionDbs({
      dbs: ['connectv3', 'transcripts_local'] as DbId[],
      pgContainer: PG,
      runner,
      probe: fakeProbe(),
    });

    expect(res.dbs.map((d) => d.action)).toEqual(['skipped', 'skipped']);
    expect(calls).toHaveLength(0);
  });

  it('sessions uses the saga_user role+pw from the manifest', async () => {
    const { runner, calls } = fakeRunner();
    await provisionDbs({ dbs: ['sessions'] as DbId[], pgContainer: PG, runner, probe: fakeProbe() });
    expect(sqlOf(calls[0])).toBe(ensureRoleSql('saga_user', 'password123'));
    expect(sqlOf(calls[1])).toBe('CREATE DATABASE sessions OWNER saga_user');
  });

  it('slot > 0: targets the slot postgres container', async () => {
    const { runner, calls } = fakeRunner();
    await provisionDbs({
      dbs: ['coach_api'] as DbId[],
      pgContainer: 'soa-s1-postgres-1',
      runner,
      probe: fakeProbe(),
    });
    expect(calls[0].args[1]).toBe('soa-s1-postgres-1');
    expect(calls[1].args[1]).toBe('soa-s1-postgres-1');
  });

  it('a failed CREATE stops the pass with ok:false + the failing db', async () => {
    const { runner } = fakeRunner(1); // every psql exits non-zero
    const res = await provisionDbs({
      dbs: ['sessions', 'content'] as DbId[],
      pgContainer: PG,
      runner,
      probe: fakeProbe(),
    });
    expect(res.ok).toBe(false);
    expect(res.failed).toBe('sessions'); // aborts at the first
  });

  it('the manifest still declares coach_api mesh-provisioned (guards the #221 blocker)', () => {
    expect(manifest.databases.coach_api.meshProvisioned).toBe(true);
  });
});
