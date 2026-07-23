/**
 * `ss env` pure-core units (soa#355): the seed-id derivation must byte-match
 * the canonical `@saga-ed/iam-seed-ids` values (the reimplementation IS the
 * contract — drift here means the safety catalog derives WRONG ids), and the
 * footprint SQL builders must refuse anything that is not a UUID (ids are
 * inlined as literals — the UUID gate is the injection guard).
 */

import { describe, expect, it } from 'vitest';
import {
  RESETTABLE_ORGS,
  RESOLVE_SQL,
  assertUuids,
  countSql,
  deriveGroupId,
  deriveGroupMembershipId,
  deriveUserId,
  extractDbTarget,
  localUrl,
  parseDatabaseUrl,
  resolveFixtureOrg,
  uuidv5,
} from '../index.js';
import type { OrgIdSets, TableRule } from '../index.js';

describe('seed-id derivation — byte-match against iam-seed-ids canon', () => {
  // Values asserted in rostering/packages/core/iam-seed-ids/src/ids.test.ts.
  it('deriveGroupId matches the canonical district ids', () => {
    expect(deriveGroupId('emptyOrg')).toBe('52a00136-285b-522c-bc70-0887cf46463a');
    expect(deriveGroupId('oakdale')).toBe('b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6');
    expect(deriveGroupId('frontier')).toBe('ea1562ee-a620-5d5c-82a8-768da7f798c2');
    expect(deriveGroupId('lincoln')).toBe('92c6c9f4-c764-519f-9873-7df7b77f5410');
  });

  it('emits RFC 4122 v5 UUIDs (version + variant nibbles)', () => {
    const id = uuidv5('anything');
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]!);
  });

  it('membership ids compose user and group deterministically', () => {
    const u = deriveUserId('empty');
    const g = deriveGroupId('emptyOrg');
    expect(deriveGroupMembershipId(u, g)).toBe(uuidv5(`group_membership:${u}:${g}`));
  });

  it('the resettable catalog is emptyOrg-only and fully derived', () => {
    expect(Object.keys(RESETTABLE_ORGS)).toEqual(['emptyOrg']);
    const org = resolveFixtureOrg('emptyOrg')!;
    expect(org.orgId).toBe('52a00136-285b-522c-bc70-0887cf46463a');
    expect(org.adminEmail).toBe('empty@saga.org');
    expect(org.adminUserId).toBe(deriveUserId('empty'));
    expect(resolveFixtureOrg('oakdale')).toBeUndefined(); // real districts are NOT resettable
    expect(resolveFixtureOrg('52a00136-285b-522c-bc70-0887cf46463a')).toBeUndefined(); // no UUID targeting
  });
});

describe('taskdef extraction — the two live DB-wiring shapes', () => {
  it('DATABASE_URL secret wins (URL shape)', () => {
    const t = extractDbTarget([
      { name: 'api', secrets: [{ name: 'DATABASE_URL', valueFrom: 'arn:aws:secretsmanager:us-west-2:1:secret:x' }] },
    ]);
    expect(t).toEqual({ shape: 'url', urlSecret: { valueFrom: 'arn:aws:secretsmanager:us-west-2:1:secret:x', kind: 'secretsmanager' } });
  });

  it('split POSTGRES_* env + password secret (ads-adm shape); SSM refs classified', () => {
    const t = extractDbTarget([
      {
        environment: [
          { name: 'POSTGRES_HOST', value: 'h.dbs-v2.local' },
          { name: 'POSTGRES_PORT', value: '5471' },
          { name: 'POSTGRES_DATABASE', value: 'ads_adm' },
          { name: 'POSTGRES_USERNAME', value: 'app' },
        ],
        secrets: [{ name: 'POSTGRES_PASSWORD', valueFrom: 'arn:aws:ssm:us-west-2:1:parameter/x' }],
      },
    ]);
    expect(t).toEqual({
      shape: 'split',
      host: 'h.dbs-v2.local',
      port: 5471,
      database: 'ads_adm',
      username: 'app',
      passwordSecret: { valueFrom: 'arn:aws:ssm:us-west-2:1:parameter/x', kind: 'ssm' },
    });
    expect(extractDbTarget([{ name: 'no-db' }])).toBeUndefined();
  });

  it('parseDatabaseUrl round-trips through localUrl with encoding preserved', () => {
    const parsed = parseDatabaseUrl('postgresql://admin:p%40ss@h.dbs-v2.local:5440/mydb');
    expect(parsed).toEqual({ host: 'h.dbs-v2.local', port: 5440, database: 'mydb', username: 'admin', password: 'p@ss' });
    expect(localUrl(parsed, 15432)).toBe('postgres://admin:p%40ss@127.0.0.1:15432/mydb');
    expect(() => parseDatabaseUrl('mysql://x/y')).toThrow(/unsupported/);
  });
});

describe('footprint SQL builders — UUID gate + shapes', () => {
  const ORG = '52a00136-285b-522c-bc70-0887cf46463a';
  const IDS: OrgIdSets = {
    orgId: ORG,
    groupIds: [ORG],
    userIds: ['e01466ba-97f4-5c74-8b87-4b63b6e9a1c1'],
    programIds: [],
  };

  it('assertUuids refuses non-UUIDs (the SQL-injection gate)', () => {
    expect(() => assertUuids(["x'; DROP TABLE groups;--"], 'evil')).toThrow(/not a UUID/);
    expect(() => assertUuids([ORG], 'ok')).not.toThrow();
  });

  it('countSql: scalar param → equality; list param → IN; empty list → null; unresolved param → null', () => {
    const orgRule: TableRule = { table: 'groups', param: 'orgId', column: 'org_id' };
    expect(countSql(orgRule, IDS)).toBe(`SELECT count(*) FROM groups WHERE org_id = '${ORG}'`);
    const listRule: TableRule = { table: 'group_memberships', param: 'groupIds', column: 'group_id' };
    expect(countSql(listRule, IDS)).toBe(`SELECT count(*) FROM group_memberships WHERE group_id IN ('${ORG}')`);
    const emptyRule: TableRule = { table: 'adm_attendance', param: 'programIds', column: 'program_id' };
    expect(countSql(emptyRule, IDS)).toBeNull();
    // A deeper-ring param the caller never resolved (undefined, not empty) —
    // e.g. periodIds in Phase-0 status — must also be null (skipped, never
    // silently mis-counted).
    const unresolvedRule: TableRule = { table: 'period_attendance_status', param: 'periodIds', column: 'period_id' };
    expect(countSql(unresolvedRule, IDS)).toBeNull();
  });

  it('RESOLVE_SQL anchors on the two org columns', () => {
    expect(RESOLVE_SQL.groupIds(ORG)).toBe(`SELECT id FROM groups WHERE org_id = '${ORG}'`);
    expect(RESOLVE_SQL.programIds(ORG)).toBe(`SELECT id FROM "Program" WHERE "organizationId" = '${ORG}'`);
    expect(RESOLVE_SQL.userIds([ORG])).toContain('FROM group_memberships WHERE group_id IN');
    expect(() => RESOLVE_SQL.groupIds('not-a-uuid')).toThrow(/not a UUID/);
  });
});
