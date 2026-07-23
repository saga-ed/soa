/**
 * `ss env org reset` integration tests (soa#355, Phase 1) — in-process runs
 * with the IO seams (`getEnvPsql`, `getEnvAws`, `getConfirm`) faked on
 * `BaseCommand.prototype`; no aws call, tunnel, or database is ever touched.
 *
 * Covers the destructive canon end-to-end: slug refusal, the both-anchors
 * requirement, the pre-flight identity assertion, --dry-run zero-mutation
 * (every SQL that reaches psql is a SELECT), a declined confirm aborting
 * clean, --yes executing the per-store transactions in leaf→iam order with
 * the iam compound asserted BYTE-EXACT (skeleton predicates included), the
 * post-verify before/after report + skeleton check, and --snapshot's
 * best-effort ladder (success, unreachable ⇒ warn+proceed, not-in-registry ⇒
 * abort before any delete).
 */

import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { ConfirmSeam, EnvAws, EnvPsql, LambdaInvokeRequest, PortForwardHandle } from '../../../runtime/index.js';
import EnvOrgReset from '../org/reset.js';

const PKG_ROOT = process.cwd();

const ORG_ID = '52a00136-285b-522c-bc70-0887cf46463a';
const ADMIN = '506605c6-f2c5-5785-9837-7970e7a2594c';
const MEMB = '80089e21-6aea-520e-8940-d292e0e12f92';
const SCHOOL = 'b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6';
const USER = '92c6c9f4-c764-519f-9873-7df7b77f5410';
const PROGRAM = 'ea1562ee-a620-5d5c-82a8-768da7f798c2';
const PERIOD = 'a0da8362-1a93-5d1d-aeaa-b6d8960e9821';
const SCHEDULE = 'c1d2e3f4-0000-4000-8000-000000000001';
const SESSION = 'MjAyNi0wNy0yMXxwZXJ8c2xvdHxwb2Q';

const URLS = {
  iam: 'postgres://iam',
  programs: 'postgres://pgm',
  scheduling: 'postgres://sch',
  sessions: 'postgres://ses',
  'ads-adm': 'postgres://ads',
  coach: 'postgres://coach',
  'iam-pii': 'postgres://pii',
} as const;

const urlArgs = (...stores: (keyof typeof URLS)[]): string[] =>
  stores.flatMap((s) => ['--url', `${s}=${URLS[s]}`]);

const ALL_URLS = urlArgs('iam', 'programs', 'scheduling', 'sessions', 'ads-adm', 'coach', 'iam-pii');

let config: Config;
let out: string[];
let warns: string[];
let prompts: string[];
let psqlCalls: { conn: string; sql: string }[];
let lambdaCalls: LambdaInvokeRequest[];

const text = (): string => out.join('\n');

/**
 * The scripted database: identity rows, one school group, one mono-org user,
 * one program/period, one session; counts are 2 before the store's
 * transaction ran and 0 after (the post-verify recount flips).
 * `leftoverTable` keeps that table's post-delete recount at 1 (the REMAIN
 * path); `breakSkeleton` makes the admin-membership probe come back empty
 * after the transactions (the SKELETON CHECK FAILED path).
 */
function installEnvPsql(
  opts: { orgName?: string; adminLogin?: string; leftoverTable?: string; breakSkeleton?: boolean } = {},
): void {
  let deleted = false;
  const fake: EnvPsql = {
    async query(conn, sql): Promise<string[][]> {
      psqlCalls.push({ conn, sql });
      if (sql.startsWith('BEGIN;')) {
        deleted = true;
        return [];
      }
      if (sql === `SELECT display_name FROM groups WHERE id = '${ORG_ID}'`) return [[opts.orgName ?? 'Empty Org']];
      // iam.users.username is the seeded admin HANDLE (the catalog slug 'empty'),
      // not the email — the identity assertion checks it against org.adminSlug.
      if (sql === `SELECT username FROM users WHERE id = '${ADMIN}'`) return [[opts.adminLogin ?? 'empty']];
      if (sql === `SELECT id FROM group_memberships WHERE id = '${MEMB}'`) {
        return deleted && opts.breakSkeleton === true ? [] : [[MEMB]];
      }
      if (sql.startsWith('SELECT count(*)')) {
        if (deleted && opts.leftoverTable !== undefined && sql.includes(`FROM ${opts.leftoverTable} `)) return [['1']];
        return [[deleted ? '0' : '2']];
      }
      if (sql.startsWith('SELECT id FROM groups WHERE org_id')) return [[SCHOOL]];
      if (sql.includes('gm.user_id') && sql.includes('NOT EXISTS')) return [[USER]]; // userDelIds
      if (sql.startsWith('SELECT DISTINCT user_id FROM group_memberships')) return [[USER]];
      if (sql.startsWith('SELECT id FROM "Program"')) return [[PROGRAM]];
      if (sql.startsWith('SELECT id FROM "TutoringPeriod"')) return [[PERIOD]];
      if (sql.startsWith('SELECT id FROM "Schedule"')) return [[SCHEDULE]];
      if (sql.startsWith('SELECT id FROM tutoring_session')) return [[SESSION]];
      if (sql.startsWith('SELECT')) return []; // remaining resolution rings: empty
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getEnvPsql: () => EnvPsql }, 'getEnvPsql').mockReturnValue(fake);
}

function installEnvAws(lambda: (req: LambdaInvokeRequest) => unknown = () => null): void {
  const fake: EnvAws = {
    async json(): Promise<unknown> {
      throw new Error('unexpected aws json call in reset tests');
    },
    async lambdaInvoke(req): Promise<unknown> {
      lambdaCalls.push(req);
      return lambda(req);
    },
    portForward(): PortForwardHandle {
      throw new Error('unexpected portForward in reset tests');
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getEnvAws: () => EnvAws }, 'getEnvAws').mockReturnValue(fake);
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

/** Every executed store transaction (BEGIN…COMMIT compound), in call order, keyed by conn. */
const transactions = (): { conn: string; sql: string }[] => psqlCalls.filter((c) => c.sql.startsWith('BEGIN;'));

/** Extract the emitted JSON object from the captured log lines. */
function emittedJson(): Record<string, unknown> {
  const t = text();
  const start = t.indexOf('{');
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(t.slice(start)) as Record<string, unknown>;
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  out = [];
  warns = [];
  prompts = [];
  psqlCalls = [];
  lambdaCalls = [];
  vi.spyOn(BaseCommand.prototype as unknown as { log: (msg?: string) => void }, 'log').mockImplementation(
    (msg?: string) => {
      out.push(String(msg ?? ''));
    },
  );
  vi.spyOn(BaseCommand.prototype as unknown as { warn: (msg: string | Error) => void }, 'warn').mockImplementation(
    (msg: string | Error) => {
      warns.push(String(msg));
    },
  );
  installEnvPsql();
  installEnvAws();
  installConfirm(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refusals (non-zero, nothing touched)', () => {
  it('refuses unknown slugs and raw UUIDs with the catalog listing', async () => {
    await expect(EnvOrgReset.run(['--org', 'jennys-training-org', ...ALL_URLS], config)).rejects.toThrow(
      /not a resettable fixture org/,
    );
    await expect(EnvOrgReset.run(['--org', ORG_ID, ...ALL_URLS], config)).rejects.toThrow(/not a resettable fixture org/);
    expect(psqlCalls).toHaveLength(0);
  });

  it('refuses to run without BOTH anchor urls (iam + programs)', async () => {
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...urlArgs('iam'), '--yes'], config)).rejects.toThrow(
      /BOTH anchor stores/,
    );
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...urlArgs('programs'), '--dry-run'], config)).rejects.toThrow(
      /BOTH anchor stores/,
    );
    expect(psqlCalls).toHaveLength(0);
  });

  it('bad --url store keys are refused with the reset store-key list (iam-pii included)', async () => {
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', '--url', 'nope=postgres://x'], config)).rejects.toThrow(
      /expected <store>=<connString>.*iam-pii/,
    );
  });

  it('an EMPTY --url connection string is refused (no silent libpq env fallback)', async () => {
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', '--url', 'iam=', '--url', 'programs=postgres://p', '--yes'], config),
    ).rejects.toThrow(/empty connection string/);
    expect(psqlCalls).toHaveLength(0);
  });

  it('IDENTITY ASSERTION: a wrong org display name refuses before any delete', async () => {
    installEnvPsql({ orgName: 'Jennys Training District' });
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes'], config)).rejects.toThrow(
      /IDENTITY ASSERTION FAILED.*Jennys Training District/,
    );
    expect(transactions()).toHaveLength(0);
    expect(psqlCalls.every((c) => c.sql.startsWith('SELECT'))).toBe(true);
  });

  it('IDENTITY ASSERTION: a wrong admin username refuses before any delete', async () => {
    installEnvPsql({ adminLogin: 'someone-else@saga.org' });
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes'], config)).rejects.toThrow(
      /IDENTITY ASSERTION FAILED.*someone-else@saga.org/,
    );
    expect(transactions()).toHaveLength(0);
  });
});

describe('--dry-run — enumerate and exit 0, zero mutation', () => {
  it('prints per-table counts (projections marked) and sends ONLY SELECTs to psql', async () => {
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--dry-run'], config)).resolves.toBeUndefined();

    expect(text()).toContain('DRY RUN');
    expect(text()).toContain('will be DELETED');
    expect(text()).toContain('[projection]');
    expect(text()).toContain('no changes made');
    expect(prompts).toHaveLength(0);
    expect(psqlCalls.length).toBeGreaterThan(0);
    for (const c of psqlCalls) {
      expect(c.sql.startsWith('SELECT')).toBe(true);
      expect(c.sql).not.toContain('DELETE');
    }
  });
});

describe('confirm flow', () => {
  it('a declined prompt aborts clean — exit 0, nothing deleted', async () => {
    installConfirm(false);
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS], config)).resolves.toBeUndefined();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('DELETES');
    expect(text()).toContain('reset aborted — nothing changed.');
    expect(transactions()).toHaveLength(0);
  });
});

describe('--yes execution — per-store transactions, order, skeleton predicates', () => {
  it('executes leaf stores first, iam LAST, one BEGIN/COMMIT compound per store', async () => {
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes'], config)).resolves.toBeUndefined();

    const tx = transactions();
    expect(tx.map((t) => t.conn)).toEqual([
      URLS.sessions,
      URLS.scheduling,
      URLS.programs,
      URLS['ads-adm'],
      URLS.coach,
      URLS['iam-pii'],
      URLS.iam,
    ]);
    for (const t of tx) {
      expect(t.sql.startsWith('BEGIN;\n')).toBe(true);
      expect(t.sql.endsWith('COMMIT;')).toBe(true);
    }
    expect(prompts).toHaveLength(0);
  });

  it('the iam transaction is BYTE-EXACT: multi-org users rule + every skeleton predicate', async () => {
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes'], config)).resolves.toBeUndefined();

    const G = `'${ORG_ID}', '${SCHOOL}'`;
    const expected =
      [
        'BEGIN',
        `DELETE FROM users WHERE id IN (SELECT DISTINCT gm.user_id FROM group_memberships gm WHERE gm.group_id IN (${G}))` +
          ` AND id <> '${ADMIN}'` +
          ` AND NOT EXISTS (SELECT 1 FROM group_memberships gm2 WHERE gm2.user_id = users.id AND gm2.group_id NOT IN (${G}))` +
          ` AND users.role = 'USER'` +
          ` AND NOT EXISTS (SELECT 1 FROM user_system_roles usr WHERE usr.user_id = users.id)`,
        `DELETE FROM group_memberships WHERE group_id IN (${G}) AND id <> '${MEMB}'`,
        `DELETE FROM personas WHERE group_id IN (${G})` +
          ` AND id NOT IN ('00000000-0000-4000-a003-000000000021', '00000000-0000-4000-a003-000000000022', '00000000-0000-4000-a003-000000000023')` +
          ` AND id NOT IN (SELECT persona_id FROM group_memberships WHERE id = '${MEMB}' AND persona_id IS NOT NULL)`,
        `DELETE FROM user_policies WHERE group_id IN (${G})`,
        `DELETE FROM group_auth_config WHERE group_id IN (${G}) AND group_id <> '${ORG_ID}'`,
        `DELETE FROM login_profiles WHERE group_id IN (${G}) AND group_id <> '${ORG_ID}'`,
        `DELETE FROM group_attributes WHERE group_id IN (${G}) AND group_id <> '${ORG_ID}'`,
        `DELETE FROM groups WHERE org_id = '${ORG_ID}' AND id <> '${ORG_ID}'`,
        'COMMIT',
      ].join(';\n') + ';';
    const iamTx = transactions().find((t) => t.conn === URLS.iam);
    expect(iamTx?.sql).toBe(expected);
  });

  it('the iam-pii sweep uses userDelIds with the admin belt-and-braces', async () => {
    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes'], config)).resolves.toBeUndefined();
    const piiTx = transactions().find((t) => t.conn === URLS['iam-pii']);
    expect(piiTx?.sql).toBe(
      `BEGIN;\nDELETE FROM user_pii WHERE user_id IN ('${USER}') AND user_id <> '${ADMIN}';\nCOMMIT;`,
    );
  });

  it('post-verify reports before/after per table and the skeleton check passes', async () => {
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--output-json'], config),
    ).resolves.toBeUndefined();

    const json = emittedJson();
    expect(json.skeletonIntact).toBe(true);
    expect(json.leftoverRows).toBe(0);
    const stores = json.stores as { store: string; tables: { table: string; before: number | null; after: number | null }[] }[];
    expect(stores.map((s) => s.store)).toEqual(['sessions', 'scheduling', 'programs', 'ads-adm', 'coach', 'iam-pii', 'iam']);
    const iam = stores.find((s) => s.store === 'iam')!;
    const users = iam.tables.find((t) => t.table === 'users')!;
    expect(users.before).toBe(2);
    expect(users.after).toBe(0);
    expect(warns.filter((w) => w.includes('REMAIN'))).toHaveLength(0);
  });

  it('leftover rows warn REMAIN (loud), land in leftoverRows, and still exit 0', async () => {
    installEnvPsql({ leftoverTable: 'adm_attendance' });
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--output-json'], config),
    ).resolves.toBeUndefined();

    expect(warns.some((w) => w.includes('ads-adm.adm_attendance: 1 row(s) REMAIN after reset'))).toBe(true);
    const json = emittedJson();
    expect(json.leftoverRows).toBe(1);
    expect(json.skeletonIntact).toBe(true);
    const stores = json.stores as { store: string; tables: { table: string; after: number | null }[] }[];
    const ads = stores.find((s) => s.store === 'ads-adm')!;
    expect(ads.tables.find((t) => t.table === 'adm_attendance')!.after).toBe(1);
  });

  it('a broken skeleton is a NON-ZERO exit — after the full JSON report was still emitted', async () => {
    installEnvPsql({ breakSkeleton: true });
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--output-json'], config),
    ).rejects.toThrow(/SKELETON CHECK FAILED/);

    // The report reached the operator BEFORE the non-zero exit.
    const json = emittedJson();
    expect(json.skeletonIntact).toBe(false);
    expect(transactions()).toHaveLength(7); // the deletes did run; the probe failed after
  });

  it('self-blinding tables (DayTypeBlock/ProgramSectionMapping) are reported verify-indirect, never a fake 0', async () => {
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--output-json'], config),
    ).resolves.toBeUndefined();

    const json = emittedJson();
    const stores = json.stores as {
      store: string;
      tables: { table: string; before: number | null; after: number | null; verify?: string }[];
    }[];
    const dtb = stores.find((s) => s.store === 'scheduling')!.tables.find((t) => t.table === '"DayTypeBlock"')!;
    expect(dtb.before).toBe(2);
    expect(dtb.after).toBeNull();
    expect(dtb.verify).toBe('indirect');
    const psm = stores.find((s) => s.store === 'programs')!.tables.find((t) => t.table === '"ProgramSectionMapping"')!;
    expect(psm.verify).toBe('indirect');
    // users is recounted for real, via the pre-resolved literal set.
    const users = stores.find((s) => s.store === 'iam')!.tables.find((t) => t.table === 'users')!;
    expect(users.after).toBe(0);
    expect(users.verify).toBeUndefined();
  });

  it('stores without a --url are skipped LOUDLY and their tables reported unconnected', async () => {
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...urlArgs('iam', 'programs'), '--yes', '--output-json'], config),
    ).resolves.toBeUndefined();

    expect(warns.some((w) => w.includes("store 'sessions' SKIPPED — no --url"))).toBe(true);
    expect(warns.some((w) => w.includes("store 'coach' SKIPPED"))).toBe(true);
    // Resolution steps for missing stores warned too (orphan unions unswept).
    expect(warns.some((w) => w.includes("store 'scheduling' has no --url"))).toBe(true);
    expect(transactions().map((t) => t.conn)).toEqual([URLS.programs, URLS.iam]);
  });
});

describe('--snapshot — best-effort orchestrator ladder', () => {
  it('snapshots stores with known registry names before deleting; unknown names warn+skip', async () => {
    // The orchestrator success body is FLAT ({ ok, name, profile, … }) — no nested `snapshot`.
    installEnvAws((req) => ({ ok: true, name: (req.payload as { serviceName: string }).serviceName, profile: 'pre-org-reset' }));

    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--snapshot', '--profile', 'dev_admin', '--output-json'], config),
    ).resolves.toBeUndefined();

    // Known registry names: iam + ads-adm (others warn about the missing name).
    expect(lambdaCalls.map((c) => c.payload)).toEqual([
      { action: 'snapshot', serviceName: 'ads-adm-postgres', profile: 'pre-org-reset' },
      { action: 'snapshot', serviceName: 'rostering-iam-canonical', profile: 'pre-org-reset' },
    ]);
    expect(lambdaCalls[0]).toMatchObject({ functionName: 'dev-db-host-orchestrator', profile: 'dev_admin', region: 'us-west-2' });
    expect(warns.some((w) => w.includes("no db-host registry name known for store 'sessions'"))).toBe(true);
    const json = emittedJson();
    const snaps = json.snapshots as { store: string; ok: boolean; name?: string; profile?: string }[];
    expect(snaps.filter((s) => s.ok).map((s) => s.store)).toEqual(['ads-adm', 'iam']);
    // The restore-point reference is captured from the flat body (finding: was always blank).
    const iamSnap = snaps.find((s) => s.store === 'iam')!;
    expect(iamSnap.profile).toBe('pre-org-reset');
    expect(iamSnap.name).toBe('rostering-iam-canonical');
    expect(transactions()).toHaveLength(7); // snapshot ran BEFORE the deletes, which still all executed
  });

  it('--snapshot-service supplies a registry name for an unhinted store', async () => {
    installEnvAws(() => ({ ok: true, name: 'program-hub-postgres', profile: 'pre-org-reset' }));
    await expect(
      EnvOrgReset.run(
        ['--org', 'emptyOrg', ...urlArgs('iam', 'programs'), '--yes', '--snapshot', '--snapshot-service', 'programs=program-hub-postgres'],
        config,
      ),
    ).resolves.toBeUndefined();
    expect(lambdaCalls.map((c) => (c.payload as { serviceName: string }).serviceName)).toEqual([
      'program-hub-postgres',
      'rostering-iam-canonical',
    ]);
  });

  it('--snapshot with --env training is refused up front (dev-only orchestrator), nothing touched', async () => {
    await expect(
      EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--snapshot', '--env', 'training'], config),
    ).rejects.toThrow(/--snapshot drives the dev db-host orchestrator/);
    expect(psqlCalls).toHaveLength(0);
    expect(lambdaCalls).toHaveLength(0);
    expect(transactions()).toHaveLength(0);
  });

  it('an unreachable orchestrator degrades to WARN and the reset proceeds', async () => {
    installEnvAws(() => {
      throw new Error('aws lambda invoke dev-db-host-orchestrator exited 255: Unable to locate credentials');
    });

    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--snapshot'], config)).resolves.toBeUndefined();

    expect(warns.some((w) => w.includes('orchestrator unreachable'))).toBe(true);
    expect(transactions()).toHaveLength(7);
  });

  it("a 'not in registry' response means the TARGET is wrong — abort before any delete", async () => {
    installEnvAws(() => ({ ok: false, error: "DB 'ads-adm-postgres' not in registry" }));

    await expect(EnvOrgReset.run(['--org', 'emptyOrg', ...ALL_URLS, '--yes', '--snapshot'], config)).rejects.toThrow(
      /not in the db-host registry.*aborting the reset/,
    );
    expect(transactions()).toHaveLength(0);
  });
});
