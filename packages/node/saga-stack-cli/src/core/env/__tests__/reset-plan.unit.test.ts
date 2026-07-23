/**
 * `env org reset` plan-builder units (soa#355 Phase 1): the UUID/base64url
 * inlining gates, resolution-step dependency behavior, per-store delete
 * ORDER (the FK-forced orderings), and — most importantly — the skeleton
 * predicates: the org row, admin user, admin membership, and seeded personas
 * must be excluded in the SQL ITSELF, and every cross-store user sweep must
 * key on userDelIds (multi-org survivors excluded), never the raw set.
 */

import { describe, expect, it } from 'vitest';
import {
  RESETTABLE_ORGS,
  RESET_GUARD_SQL,
  RESET_RESOLVE_STEPS,
  RESET_STORES,
  assertSessionIds,
  buildResetPlan,
  initialResetIds,
  validateResetIds,
} from '../index.js';
import type { ResetIdSets } from '../index.js';

const ORG = RESETTABLE_ORGS.emptyOrg!;
const SCHOOL = 'b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6';
const USER = '92c6c9f4-c764-519f-9873-7df7b77f5410';
const PROGRAM = 'ea1562ee-a620-5d5c-82a8-768da7f798c2';
const PERIOD = 'a0da8362-1a93-5d1d-aeaa-b6d8960e9821';
const SCHEDULE = 'c1d2e3f4-0000-4000-8000-000000000001';

function fullIds(): ResetIdSets {
  const ids = initialResetIds(ORG);
  ids.groupIds = [ORG.orgId, SCHOOL];
  ids.userIds = [ORG.adminUserId, USER];
  ids.userDelIds = [USER];
  ids.programIds = [PROGRAM];
  ids.periodIds = [PERIOD];
  // A resolved reset carries the schedule ring too — schedule-keyed tables
  // (e.g. "DayTypeBlock") are only exercised when scheduleIds is non-empty.
  ids.scheduleIds = [SCHEDULE];
  return ids;
}

describe('initialResetIds — catalog anchors', () => {
  it('seeds anchors and empty live sets', () => {
    const ids = initialResetIds(ORG);
    expect(ids.orgId).toBe('52a00136-285b-522c-bc70-0887cf46463a');
    expect(ids.adminMembershipId).toBe('80089e21-6aea-520e-8940-d292e0e12f92');
    expect(ids.groupIds).toEqual([ids.orgId]);
    expect(ids.userIds).toEqual([ids.adminUserId]);
    expect(ids.userDelIds).toEqual([]);
    expect(ids.seededPersonaIds).toEqual([
      '00000000-0000-4000-a003-000000000021',
      '00000000-0000-4000-a003-000000000022',
      '00000000-0000-4000-a003-000000000023',
    ]);
  });
});

describe('inlining gates', () => {
  it('validateResetIds refuses a non-UUID in any uuid set', () => {
    const ids = fullIds();
    ids.podIds = ["x'; DROP TABLE pods;--"];
    expect(() => validateResetIds(ids)).toThrow(/not a UUID/);
  });

  it('sessionIds are base64url-gated, not UUID-gated', () => {
    expect(() => assertSessionIds(['MjAyNi0wNy0yMXxwfHN8cA=='])).not.toThrow();
    // Live dev shape: a `v2.`-versioned opaque key (the `.` is part of the charset).
    expect(() => assertSessionIds(['v2.D1CLobLD1AACQACAAAAAAAAAkakvfCpmRVe-olzN7dO3fiMiMNFGqI5XVK5UqL_-XkoO'])).not.toThrow();
    expect(() => assertSessionIds(["evil' OR 1=1--"])).toThrow(/not a base64url/);
    const ids = fullIds();
    ids.sessionIds = ['ok_-='];
    expect(() => validateResetIds(ids)).not.toThrow();
    ids.sessionIds = ["no'quote"];
    expect(() => validateResetIds(ids)).toThrow(/base64url/);
  });

  it('buildResetPlan and every resolve step validate before inlining', () => {
    const ids = fullIds();
    ids.scheduleIds = ['nope'];
    expect(() => buildResetPlan(ids)).toThrow(/not a UUID/);
    for (const step of RESET_RESOLVE_STEPS) {
      expect(() => step.sql(ids)).toThrow(/not a UUID/);
    }
  });
});

describe('resolution steps', () => {
  it('run in dependency order and skip when prerequisites are empty', () => {
    const ids = initialResetIds(ORG);
    // With no programIds yet, every deeper-ring step short-circuits to null.
    for (const step of RESET_RESOLVE_STEPS) {
      if (['groupIds', 'userIds', 'userDelIds', 'programIds'].includes(step.set)) continue;
      expect(step.sql(ids), step.label).toBeNull();
    }
  });

  it('userDelIds carries the multi-org rule, the env-wide-actor rule, AND the admin exclusion', () => {
    const step = RESET_RESOLVE_STEPS.find((s) => s.set === 'userDelIds')!;
    const sql = step.sql(fullIds())!;
    expect(sql).toContain(`gm.user_id <> '${ORG.adminUserId}'`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM group_memberships gm2');
    expect(sql).toContain(`gm2.group_id NOT IN ('${ORG.orgId}', '${SCHOOL}')`);
    // Env-wide actors have identity WITHOUT membership rows — never deletable.
    expect(sql).toContain(`NOT EXISTS (SELECT 1 FROM users u WHERE u.id = gm.user_id AND u.role <> 'USER')`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM user_system_roles usr WHERE usr.user_id = gm.user_id)');
  });

  it('slot/schedule/pod sets union the projection-side orphan sources', () => {
    const ids = fullIds();
    const stores = (set: string): string[] =>
      RESET_RESOLVE_STEPS.filter((s) => s.set === set && s.sql(ids) !== null).map((s) => s.store);
    expect(stores('slotIds')).toEqual(['scheduling', 'programs', 'sessions']);
    expect(stores('scheduleIds')).toEqual(['scheduling', 'sessions', 'sessions']);
    expect(stores('podIds')).toEqual(['programs', 'sessions']);
  });
});

describe('buildResetPlan — order, skeleton predicates, empty-set skips', () => {
  it('stores execute leaf-first with iam LAST', () => {
    expect(RESET_STORES.map((s) => s.key)).toEqual([
      'sessions',
      'scheduling',
      'programs',
      'ads-adm',
      'coach',
      'iam-pii',
      'iam',
    ]);
  });

  it('programs deletes pod_assignment BEFORE slot_projection (ON DELETE RESTRICT)', () => {
    const tables = RESET_STORES.find((s) => s.key === 'programs')!.rules.map((r) => r.table);
    expect(tables.indexOf('pod_assignment')).toBeGreaterThanOrEqual(0);
    expect(tables.indexOf('pod_assignment')).toBeLessThan(tables.indexOf('slot_projection'));
    expect(tables.indexOf('"Pod"')).toBeLessThan(tables.indexOf('"TutoringPeriod"'));
    expect(tables.indexOf('"TutoringPeriod"')).toBeLessThan(tables.indexOf('"Program"'));
  });

  it('scheduling deletes CalendarEvent before RecurrenceRule/DayType', () => {
    const tables = RESET_STORES.find((s) => s.key === 'scheduling')!.rules.map((r) => r.table);
    expect(tables.indexOf('"CalendarEvent"')).toBeLessThan(tables.indexOf('"RecurrenceRule"'));
    expect(tables.indexOf('"CalendarEvent"')).toBeLessThan(tables.indexOf('"DayType"'));
    expect(tables.indexOf('"DayTypeBlock"')).toBe(0);
  });

  it('iam order: users first (the membership evidence), groups last', () => {
    const tables = RESET_STORES.find((s) => s.key === 'iam')!.rules.map((r) => r.table);
    expect(tables[0]).toBe('users');
    expect(tables[tables.length - 1]).toBe('groups');
    expect(tables.indexOf('users')).toBeLessThan(tables.indexOf('group_memberships'));
  });

  it('skeleton predicates are IN the SQL', () => {
    const plan = buildResetPlan(fullIds());
    const iam = plan.find((s) => s.store === 'iam')!;
    const sql = (table: string): string => iam.tables.find((t) => t.table === table)!.deleteSql!;
    expect(sql('users')).toContain(`id <> '${ORG.adminUserId}'`);
    expect(sql('users')).toContain('NOT EXISTS (SELECT 1 FROM group_memberships gm2');
    // Env-wide actors (staff/service accounts): role marker + system roles.
    expect(sql('users')).toContain(`users.role = 'USER'`);
    expect(sql('users')).toContain('NOT EXISTS (SELECT 1 FROM user_system_roles usr WHERE usr.user_id = users.id)');
    expect(sql('group_memberships')).toContain(`id <> '${ORG.adminMembershipId}'`);
    expect(sql('personas')).toContain(
      `id NOT IN ('00000000-0000-4000-a003-000000000021', '00000000-0000-4000-a003-000000000022', '00000000-0000-4000-a003-000000000023')`,
    );
    expect(sql('personas')).toContain(`id = '${ORG.adminMembershipId}' AND persona_id IS NOT NULL`);
    expect(sql('groups')).toBe(`DELETE FROM groups WHERE org_id = '${ORG.orgId}' AND id <> '${ORG.orgId}'`);
    // Seeded org-row config survives; child-group config dies.
    expect(sql('group_attributes')).toContain(`group_id <> '${ORG.orgId}'`);
    expect(sql('group_auth_config')).toContain(`group_id <> '${ORG.orgId}'`);
  });

  it('sessions authz mirrors keep the admin membership + org hierarchy rows', () => {
    const plan = buildResetPlan(fullIds());
    const sessions = plan.find((s) => s.store === 'sessions')!;
    const sql = (table: string): string => sessions.tables.find((t) => t.table === table)!.deleteSql!;
    expect(sql('authz_group_membership')).toContain(`iam_row_id IS DISTINCT FROM '${ORG.adminMembershipId}'`);
    expect(sql('authz_group_hierarchy')).toContain(`child_group_id <> '${ORG.orgId}'`);
    expect(sql('authz_persona_assignment')).toContain(`user_id IN ('${USER}')`);
    expect(sql('authz_persona_assignment')).toContain(`group_id <> '${ORG.orgId}'`);
  });

  it('every user-keyed sweep uses userDelIds (multi-org survivors keep mirrors/PII/progress)', () => {
    const ids = fullIds();
    ids.userDelIds = []; // everyone reachable is multi-org ⇒ nothing user-keyed dies
    const plan = buildResetPlan(ids);
    const table = (store: string, t: string) => plan.find((s) => s.store === store)!.tables.find((x) => x.table === t)!;
    expect(table('iam-pii', 'user_pii').deleteSql).toBeNull();
    expect(table('coach', 'content_instance').deleteSql).toBeNull();
    expect(table('coach', 'module_answer').deleteSql).toBeNull();
    expect(table('programs', 'user_projection').deleteSql).toBeNull();
    expect(table('sessions', 'user_projection').deleteSql).toBeNull();
    // Group-keyed halves still apply — minus the admin's kept mirror.
    expect(table('coach', 'persona_assignment').deleteSql).toBe(
      `DELETE FROM persona_assignment WHERE (group_id IN ('${ORG.orgId}', '${SCHOOL}') AND iam_row_id IS DISTINCT FROM '${ORG.adminMembershipId}')`,
    );
  });

  it("coach persona_assignment keeps the admin's org-row mirror (its iam source row survives the reset)", () => {
    const plan = buildResetPlan(fullIds());
    const coach = plan.find((s) => s.store === 'coach')!;
    const sql = coach.tables.find((t) => t.table === 'persona_assignment')!.deleteSql!;
    expect(sql).toBe(
      `DELETE FROM persona_assignment WHERE user_id IN ('${USER}')` +
        ` OR (group_id IN ('${ORG.orgId}', '${SCHOOL}') AND iam_row_id IS DISTINCT FROM '${ORG.adminMembershipId}')`,
    );
  });

  it("adm_attendance's user disjunct is SCOPED to the org's periods; period_attendance_status keys on period_id", () => {
    const plan = buildResetPlan(fullIds());
    const ads = plan.find((s) => s.store === 'ads-adm')!;
    expect(ads.tables[0]!.deleteSql).toBe(
      `DELETE FROM adm_attendance WHERE program_id IN ('${PROGRAM}') OR (iam_user_id IN ('${USER}') AND period_id IN ('${PERIOD}'))`,
    );
    expect(ads.tables[1]!.deleteSql).toBe(`DELETE FROM period_attendance_status WHERE period_id IN ('${PERIOD}')`);
    // Never an unscoped user disjunct: with no periods resolved, only the
    // program leg remains (a bare iam_user_id predicate could reach OTHER
    // orgs' attendance rows).
    const noPeriods = fullIds();
    noPeriods.periodIds = [];
    const plan2 = buildResetPlan(noPeriods);
    expect(plan2.find((s) => s.store === 'ads-adm')!.tables[0]!.deleteSql).toBe(
      `DELETE FROM adm_attendance WHERE program_id IN ('${PROGRAM}')`,
    );
  });

  it('empty id-sets skip statements (IN () never emitted) and drop out of the transaction', () => {
    const ids = initialResetIds(ORG); // nothing resolved
    const plan = buildResetPlan(ids);
    const scheduling = plan.find((s) => s.store === 'scheduling')!;
    // Only the org-anchored program_projection survives the skips.
    expect(scheduling.statements.map((s) => s.table)).toEqual(['program_projection']);
    expect(scheduling.transactionSql).toBe(
      `BEGIN;\nDELETE FROM program_projection WHERE organization_id = '${ORG.orgId}';\nCOMMIT;`,
    );
    const adsAdm = plan.find((s) => s.store === 'ads-adm')!;
    expect(adsAdm.transactionSql).toBeNull();
    for (const store of plan) {
      for (const t of store.tables) {
        if (t.deleteSql !== null) expect(t.deleteSql).not.toContain('IN ()');
      }
    }
  });

  it('countSql shares each delete predicate byte-for-byte — except self-blinding recounts', () => {
    const plan = buildResetPlan(fullIds());
    for (const store of plan) {
      for (const t of store.tables) {
        if (t.deleteSql === null) {
          expect(t.countSql).toBeNull();
          continue;
        }
        if (store.store === 'iam' && t.table === 'users') continue; // literal-set recount, asserted below
        expect(t.countSql).toBe(t.deleteSql.replace(`DELETE FROM ${t.table}`, `SELECT count(*) FROM ${t.table}`));
      }
    }
    // The users recount uses the pre-resolved userDelIds literal set (same
    // rows at plan time): the delete's membership subquery would self-blind
    // post-verify because group_memberships dies in the same transaction.
    const users = plan.find((s) => s.store === 'iam')!.tables.find((t) => t.table === 'users')!;
    expect(users.countSql).toBe(`SELECT count(*) FROM users WHERE id IN ('${USER}')`);
  });

  it('subquery-only predicates are marked verify-indirect (no meaningful recount exists)', () => {
    const plan = buildResetPlan(fullIds());
    const t = (store: string, table: string) => plan.find((s) => s.store === store)!.tables.find((x) => x.table === table)!;
    expect(t('scheduling', '"DayTypeBlock"').verify).toBe('indirect');
    expect(t('programs', '"ProgramSectionMapping"').verify).toBe('indirect');
    // users is NOT indirect — its literal-set recount is meaningful.
    expect(t('iam', 'users').verify).toBeUndefined();
  });

  it('transactions are BEGIN/COMMIT-wrapped compounds', () => {
    const plan = buildResetPlan(fullIds());
    for (const store of plan) {
      if (store.transactionSql === null) continue;
      expect(store.transactionSql.startsWith('BEGIN;\n')).toBe(true);
      expect(store.transactionSql.endsWith('COMMIT;')).toBe(true);
      // Every inner statement is a DELETE (subquery SELECTs are inside predicates only).
      for (const stmt of store.transactionSql.split(';\n').slice(1, -1)) {
        expect(stmt.startsWith('DELETE FROM ')).toBe(true);
      }
    }
  });
});

describe('guard SQL', () => {
  it('identity/skeleton probes are UUID-gated and target the deterministic ids', () => {
    expect(RESET_GUARD_SQL.orgRow(ORG.orgId)).toBe(`SELECT display_name FROM groups WHERE id = '${ORG.orgId}'`);
    expect(RESET_GUARD_SQL.adminUser(ORG.adminUserId)).toBe(`SELECT username FROM users WHERE id = '${ORG.adminUserId}'`);
    expect(RESET_GUARD_SQL.adminMembership(ORG.adminMembershipId)).toBe(
      `SELECT id FROM group_memberships WHERE id = '${ORG.adminMembershipId}'`,
    );
    expect(() => RESET_GUARD_SQL.orgRow('evil')).toThrow(/not a UUID/);
  });
});
