/**
 * `ss env org reset` delete-plan model (soa#355, Phase 1) — PURE.
 *
 * Extends the Phase-0 footprint with the FULL org-reachable delete cascade,
 * verified table-by-table against the owning repos' prisma schemas
 * (2026-07-21 mining pass; each rule's source is the store's `schemaSource`
 * in `footprint.ts` plus rostering iam-pii-db and the program-hub trio):
 *
 *   - id-set RESOLUTION steps (`RESET_RESOLVE_STEPS`): programIds → periodIds
 *     → cohortIds/podIds/slotIds/scheduleIds/sessionIds, run in dependency
 *     order against the connected stores BEFORE any delete anywhere (deleting
 *     destroys the resolution evidence). Projection-side unions sweep orphan
 *     ids whose source rows are already gone (e.g. a schedule REPLACE mints a
 *     new scheduleId — stale generations linger only in sessions refs).
 *   - per-store ordered DELETE plans (`RESET_STORES` → `buildResetPlan`):
 *     children before parents (the two hard FK constraints: programs
 *     `pod_assignment`→`slot_projection` is ON DELETE RESTRICT; scheduling
 *     `CalendarEvent` carries SetNull/default FKs to RecurrenceRule/DayType).
 *     sessions-api is `relationMode = "prisma"` — zero DB-level FKs there.
 *
 * SKELETON PROTECTION IS IN THE SQL, not in command logic: the org group row,
 * the admin user, the admin's seeded membership, and the org's seeded personas
 * are excluded by explicit `<>` / `NOT IN` predicates on their deterministic
 * catalog ids, and the `users` delete carries the multi-org rule — a user with
 * ANY membership outside the org's groups (any status; historical rows still
 * prove external existence) survives — plus the env-wide-actor rule: iam
 * models environment-level identity WITHOUT membership rows (`users.role`
 * other than USER, `user_system_roles`), so users carrying either marker
 * survive even when their only membership is inside the org. Cross-store user
 * sweeps (projections, PII, coach progress) use `userDelIds` — the
 * survivors-excluded set, which carries the SAME exclusions — never the raw
 * reachable set, so a surviving user's mirrors/PII/progress survive along
 * with their iam row.
 *
 * SQL SAFETY: ids are inlined as literals (psql shell-out has no bind params).
 * Every UUID set passes `assertUuids`; session ids are base64url-encoded
 * natural keys (`tutoring_session.id = base64url(date|periodId|slotId|podId)`),
 * NOT UUIDs, and pass their own strict-charset gate instead.
 *
 * Deliberately NEVER touched, in every store: `outbox_event`,
 * `consumed_events`, `snapshot_metadata`, `audit_logs` (DB-rule append-only),
 * sessions' `projection_readiness` + `authz_persona_definition`, coach's
 * authored-content tables + `persona_definition`, programs' `content_item`
 * (global catalog), and the whole content-api database (no org-reachable
 * column anywhere).
 */

import { assertUuids } from './footprint.js';
import type { FixtureOrg } from './seed-ids.js';

/** db-host-v2 orchestrator Lambda (dev account; `${EnvironmentName}` is always `dev`). */
export const ORCHESTRATOR_LAMBDA = 'dev-db-host-orchestrator';

/** Snapshot profile name the reset writes restore points under (versioned, immutable). */
export const SNAPSHOT_PROFILE = 'pre-org-reset';

/** The list-valued id-sets a reset resolves and deletes by. */
export type ResetSetKey =
  | 'groupIds'
  | 'userIds'
  | 'userDelIds'
  | 'programIds'
  | 'periodIds'
  | 'cohortIds'
  | 'podIds'
  | 'slotIds'
  | 'scheduleIds'
  | 'sessionIds';

/** Everything the delete plans are parameterized by (catalog anchors + live-resolved sets). */
export interface ResetIdSets {
  orgId: string;
  adminUserId: string;
  adminMembershipId: string;
  /** The org's seeded personas (fixed catalog ids) — part of the skeleton, never deleted. */
  seededPersonaIds: string[];
  /** All org group ids INCLUDING the org row itself (org_id is self for the district). */
  groupIds: string[];
  /** RAW reachable member set (reporting only — deletes use userDelIds). */
  userIds: string[];
  /** Deletable users: every membership inside the org's groups, admin excluded. */
  userDelIds: string[];
  programIds: string[];
  periodIds: string[];
  cohortIds: string[];
  podIds: string[];
  slotIds: string[];
  scheduleIds: string[];
  /** base64url-encoded natural keys, NOT UUIDs. */
  sessionIds: string[];
}

/** Catalog-derived starting point: anchors present, live sets empty. */
export function initialResetIds(org: FixtureOrg): ResetIdSets {
  return {
    orgId: org.orgId,
    adminUserId: org.adminUserId,
    adminMembershipId: org.adminMembershipId,
    seededPersonaIds: [...org.seededPersonaIds],
    groupIds: [org.orgId],
    userIds: [org.adminUserId],
    userDelIds: [],
    programIds: [],
    periodIds: [],
    cohortIds: [],
    podIds: [],
    slotIds: [],
    scheduleIds: [],
    sessionIds: [],
  };
}

/**
 * `tutoring_session.id` is a versioned opaque key — live dev shape is
 * `v2.<base64url payload>` (e.g. `v2.D1CLobLD1AAC…`); the version prefix and
 * its `.` separator plus the base64url alphabet are the full charset. None of
 * `[A-Za-z0-9._=-]` can smuggle a quote into an inlined literal (only `'`
 * could, and standard_conforming_strings makes backslashes inert), so this is
 * the sessionIds analogue of `assertUuids` — anything outside it is refused.
 */
const SESSION_ID_RE = /^[A-Za-z0-9._=-]+$/;

/** Every session id inlined into SQL must be strict base64url — throws otherwise. */
export function assertSessionIds(ids: readonly string[]): void {
  for (const id of ids) {
    if (!SESSION_ID_RE.test(id)) {
      throw new Error(`sessionIds: '${id}' is not a base64url session id — refusing to build SQL with it`);
    }
  }
}

/** Validate EVERY id in a ResetIdSets before any of them is inlined into SQL. */
export function validateResetIds(ids: ResetIdSets): void {
  assertUuids([ids.orgId], 'orgId');
  assertUuids([ids.adminUserId], 'adminUserId');
  assertUuids([ids.adminMembershipId], 'adminMembershipId');
  assertUuids(ids.seededPersonaIds, 'seededPersonaIds');
  assertUuids(ids.groupIds, 'groupIds');
  assertUuids(ids.userIds, 'userIds');
  assertUuids(ids.userDelIds, 'userDelIds');
  assertUuids(ids.programIds, 'programIds');
  assertUuids(ids.periodIds, 'periodIds');
  assertUuids(ids.cohortIds, 'cohortIds');
  assertUuids(ids.podIds, 'podIds');
  assertUuids(ids.slotIds, 'slotIds');
  assertUuids(ids.scheduleIds, 'scheduleIds');
  assertSessionIds(ids.sessionIds);
}

const lit = (ids: readonly string[]): string => ids.map((id) => `'${id}'`).join(', ');

/** `<column> IN (…)` or null when the set is empty (`IN ()` is invalid SQL). */
const inSet = (column: string, set: readonly string[]): string | null =>
  set.length === 0 ? null : `${column} IN (${lit(set)})`;

/** Wrap a SQL builder so the full UUID/charset gate runs before ANY inlining. */
const guarded =
  <T>(build: (ids: ResetIdSets) => T) =>
  (ids: ResetIdSets): T => {
    validateResetIds(ids);
    return build(ids);
  };

/** One id-set resolution step (a SELECT against one store; results union into the set). */
export interface ResetResolveStep {
  set: ResetSetKey;
  /** Store key whose `--url` connection the SELECT runs against. */
  store: string;
  label: string;
  /** SQL, or null when a prerequisite set is empty (nothing to resolve). */
  sql: (ids: ResetIdSets) => string | null;
}

/**
 * Resolution steps in dependency order. Union semantics throughout: results
 * merge into the (anchor-seeded) sets, deduped, so projection-side steps sweep
 * orphan ids whose source-of-record rows are already gone.
 */
export const RESET_RESOLVE_STEPS: ResetResolveStep[] = [
  {
    set: 'groupIds',
    store: 'iam',
    label: 'org groups',
    sql: guarded((ids) => `SELECT id FROM groups WHERE org_id = '${ids.orgId}'`),
  },
  {
    set: 'userIds',
    store: 'iam',
    label: 'reachable member users',
    sql: guarded((ids) => `SELECT DISTINCT user_id FROM group_memberships WHERE ${inSet('group_id', ids.groupIds)}`),
  },
  {
    // The multi-org rule LIVES HERE (and again, belt-and-braces, in the users
    // DELETE): a user with any membership outside the org's groups — any
    // status; historical rows still prove external existence — is NOT
    // deletable. Neither is an env-wide actor: iam grants environment-level
    // identity WITHOUT membership rows (`users.role` other than USER,
    // `user_system_roles`), so either marker means the user is NOT org-owned
    // even if their only membership row is inside the org.
    set: 'userDelIds',
    store: 'iam',
    label: 'deletable users (multi-org members, env-wide actors, and the admin excluded)',
    sql: guarded(
      (ids) =>
        `SELECT DISTINCT gm.user_id FROM group_memberships gm WHERE gm.group_id IN (${lit(ids.groupIds)})` +
        ` AND gm.user_id <> '${ids.adminUserId}'` +
        ` AND NOT EXISTS (SELECT 1 FROM group_memberships gm2 WHERE gm2.user_id = gm.user_id AND gm2.group_id NOT IN (${lit(ids.groupIds)}))` +
        ` AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = gm.user_id AND u.role <> 'USER')` +
        ` AND NOT EXISTS (SELECT 1 FROM user_system_roles usr WHERE usr.user_id = gm.user_id)`,
    ),
  },
  {
    set: 'programIds',
    store: 'programs',
    label: 'programs',
    sql: guarded((ids) => `SELECT id FROM "Program" WHERE "organizationId" = '${ids.orgId}'`),
  },
  {
    // No deletedAt filter anywhere in resolution: tombstoned rows must be swept too.
    set: 'periodIds',
    store: 'programs',
    label: 'tutoring periods',
    sql: guarded((ids) => {
      const c = inSet('"programId"', ids.programIds);
      return c === null ? null : `SELECT id FROM "TutoringPeriod" WHERE ${c}`;
    }),
  },
  {
    set: 'cohortIds',
    store: 'programs',
    label: 'cohorts',
    sql: guarded((ids) => {
      const c = inSet('"periodId"', ids.periodIds);
      return c === null ? null : `SELECT id FROM "Cohort" WHERE ${c}`;
    }),
  },
  {
    set: 'podIds',
    store: 'programs',
    label: 'pods',
    sql: guarded((ids) => {
      const c = inSet('"periodId"', ids.periodIds);
      return c === null ? null : `SELECT id FROM "Pod" WHERE ${c}`;
    }),
  },
  {
    set: 'podIds',
    store: 'sessions',
    label: 'pods (sessions orphan union)',
    sql: guarded((ids) => {
      const c = inSet('period_id', ids.periodIds);
      return c === null ? null : `SELECT id FROM pod_projection WHERE ${c}`;
    }),
  },
  {
    set: 'scheduleIds',
    store: 'scheduling',
    label: 'schedules',
    sql: guarded((ids) => {
      const c = inSet('"programId"', ids.programIds);
      return c === null ? null : `SELECT id FROM "Schedule" WHERE ${c}`;
    }),
  },
  {
    // A schedule REPLACE mints a NEW scheduleId; stale generations linger only
    // in sessions-side refs — union them in for the schedule-keyed ref sweeps.
    set: 'scheduleIds',
    store: 'sessions',
    label: 'schedules (sessions projection union)',
    sql: guarded((ids) => {
      const c = inSet('program_id', ids.programIds);
      return c === null ? null : `SELECT id FROM schedule_projection WHERE ${c}`;
    }),
  },
  {
    set: 'scheduleIds',
    store: 'sessions',
    label: 'schedules (recurrence-rule-ref union)',
    sql: guarded((ids) => {
      const c = inSet('period_id', ids.periodIds);
      return c === null ? null : `SELECT DISTINCT schedule_id FROM recurrence_rule_ref WHERE ${c}`;
    }),
  },
  {
    // Slot rows ARE RecurrenceRule rows with a non-null periodId (scheduling
    // is the source of record for slotIds).
    set: 'slotIds',
    store: 'scheduling',
    label: 'slots (recurrence rules)',
    sql: guarded((ids) => {
      const c = inSet('"periodId"', ids.periodIds);
      return c === null ? null : `SELECT id FROM "RecurrenceRule" WHERE ${c}`;
    }),
  },
  {
    set: 'slotIds',
    store: 'programs',
    label: 'slots (programs projection union)',
    sql: guarded((ids) => {
      const c = inSet('period_id', ids.periodIds);
      return c === null ? null : `SELECT id FROM slot_projection WHERE ${c}`;
    }),
  },
  {
    set: 'slotIds',
    store: 'sessions',
    label: 'slots (sessions projection union)',
    sql: guarded((ids) => {
      const c = inSet('period_id', ids.periodIds);
      return c === null ? null : `SELECT id FROM slot_projection WHERE ${c}`;
    }),
  },
  {
    // Resolve BEFORE tutoring_session is deleted — the rows are the evidence.
    set: 'sessionIds',
    store: 'sessions',
    label: 'session ids',
    sql: guarded((ids) => {
      const c = inSet('"periodId"', ids.periodIds);
      return c === null ? null : `SELECT id FROM tutoring_session WHERE ${c}`;
    }),
  },
];

/** One org-reachable table and how its rows die. */
export interface ResetDeleteRule {
  table: string;
  /** Event-materialized mirror (the orphan category — never self-heals). */
  projection?: boolean;
  note?: string;
  /** WHERE clause, or null to skip (empty id-set — the rows cannot exist). */
  where: (ids: ResetIdSets) => string | null;
  /**
   * Count/verify predicate override for tables whose delete predicate would
   * SELF-BLIND the post-verify recount (a subquery over rows deleted in the
   * same transaction reads 0 whether or not the delete worked). Must select
   * the same rows as `where` at plan time.
   */
  count?: (ids: ResetIdSets) => string | null;
  /**
   * No non-blinding recount predicate exists (the delete subquery is the only
   * way to reach the rows) — post-verify reports the table as
   * verify-indirect instead of a structurally-zero recount.
   */
  verify?: 'indirect';
}

/** One store's reset definition, listed in EXECUTION order (leaf stores first, iam last). */
export interface ResetStoreDef {
  /** Store key used in `--url <key>=<conn>` (superset of the footprint keys: adds `iam-pii`). */
  key: string;
  service: string;
  /** db-host-v2 registry serviceName for `--snapshot`, where known. */
  dbService?: string;
  rules: ResetDeleteRule[];
}

/**
 * The full delete cascade. Store order = execution order: leaf stores first so
 * a mid-run failure leaves the iam anchor evidence (groups/memberships) intact
 * for a re-run; iam — whose memberships are the resolution source — dies last.
 */
export const RESET_STORES: ResetStoreDef[] = [
  {
    key: 'sessions',
    service: 'sessions-api (program-hub)',
    rules: [
      // relationMode="prisma" — no DB FKs; order is logical (session children first).
      { table: 'session_observation_note', where: guarded((ids) => inSet('session_id', ids.sessionIds)) },
      { table: 'qtf_evaluation', where: guarded((ids) => inSet('session_id', ids.sessionIds)) },
      {
        table: 'session_alias',
        note: 'aliases minted before their lazily-written session row are unreachable via sessionIds (known residue)',
        where: guarded((ids) => inSet('canonical_id', ids.sessionIds)),
      },
      { table: 'tutoring_session', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: 'session_instance_override', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: 'schedule_projection', projection: true, where: guarded((ids) => inSet('program_id', ids.programIds)) },
      { table: 'slot_projection', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'recurrence_rule_ref', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'scheduling_holiday_ref', projection: true, where: guarded((ids) => inSet('schedule_id', ids.scheduleIds)) },
      { table: 'occurrence_cancellation_ref', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'slot_occurrence_cancellation_ref', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'occurrence_time_override_ref', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'manual_addition_ref', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'period_meeting_ref', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'period_membership', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'pod_membership', projection: true, where: guarded((ids) => inSet('pod_id', ids.podIds)) },
      { table: 'cohort_membership', projection: true, where: guarded((ids) => inSet('cohort_id', ids.cohortIds)) },
      { table: 'pod_tutor_projection', projection: true, where: guarded((ids) => inSet('pod_id', ids.podIds)) },
      { table: 'program_projection', projection: true, where: guarded((ids) => inSet('id', ids.programIds)) },
      { table: 'period_projection', projection: true, where: guarded((ids) => inSet('program_id', ids.programIds)) },
      { table: 'cohort_projection', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'pod_projection', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'pod_assignment_projection', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'program_school_mapping_projection', projection: true, where: guarded((ids) => inSet('program_id', ids.programIds)) },
      {
        table: 'pod_assignment_override_projection',
        projection: true,
        note: 'prisma model is named PodAssignmentOverride; the TABLE is pod_assignment_override_projection',
        where: guarded((ids) => inSet('slot_id', ids.slotIds)),
      },
      {
        // The admin's org membership survives in iam — its mirror survives too.
        table: 'authz_group_membership',
        projection: true,
        where: guarded(
          (ids) => `group_id IN (${lit(ids.groupIds)}) AND iam_row_id IS DISTINCT FROM '${ids.adminMembershipId}'`,
        ),
      },
      {
        // The org group row survives in iam — keep its hierarchy mirror.
        table: 'authz_group_hierarchy',
        projection: true,
        where: guarded((ids) => `child_group_id IN (${lit(ids.groupIds)}) AND child_group_id <> '${ids.orgId}'`),
      },
      {
        // Two sweeps in one predicate: assignments OF deleted users anywhere in
        // the org, plus assignments scoped to dying child groups (surviving
        // users' org-row assignments — the admin's — are kept).
        table: 'authz_persona_assignment',
        projection: true,
        where: guarded((ids) => {
          const parts: string[] = [];
          const u = inSet('user_id', ids.userDelIds);
          if (u !== null) parts.push(u);
          parts.push(`(group_id IN (${lit(ids.groupIds)}) AND group_id <> '${ids.orgId}')`);
          return parts.join(' OR ');
        }),
      },
      {
        // userDelIds, NOT the raw reachable set: a multi-org user's iam row
        // survives, so its mirror must too (a deleted mirror never self-heals).
        table: 'user_projection',
        projection: true,
        where: guarded((ids) => inSet('id', ids.userDelIds)),
      },
    ],
  },
  {
    key: 'scheduling',
    service: 'scheduling-api (program-hub)',
    rules: [
      {
        table: '"DayTypeBlock"',
        // Reached ONLY through DayType (deleted later in the same transaction)
        // — the recount would self-blind, so post-verify reports it indirect.
        verify: 'indirect',
        where: guarded((ids) => {
          const c = inSet('"scheduleId"', ids.scheduleIds);
          return c === null ? null : `"dayTypeId" IN (SELECT id FROM "DayType" WHERE ${c})`;
        }),
      },
      // CalendarEvent BEFORE RecurrenceRule/DayType (SetNull/default FKs S:153-154).
      { table: '"CalendarEvent"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"RecurrenceRule"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"DayType"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"SlotOccurrenceCancellation"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"OccurrenceTimeOverride"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"ManualAddition"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"PeriodScheduleConfig"', where: guarded((ids) => inSet('"scheduleId"', ids.scheduleIds)) },
      { table: '"Schedule"', where: guarded((ids) => inSet('"programId"', ids.programIds)) },
      // period_id is the PK; program_id is nullable — filter on period_id.
      { table: 'rotation_config_projection', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'period_projection', projection: true, where: guarded((ids) => inSet('program_id', ids.programIds)) },
      { table: 'program_projection', projection: true, where: guarded((ids) => `organization_id = '${ids.orgId}'`) },
    ],
  },
  {
    key: 'programs',
    service: 'programs-api (program-hub)',
    rules: [
      // pod_assignment → slot_projection is ON DELETE RESTRICT: #1 must precede
      // the slot_projection delete below. Everything else child-first anyway.
      { table: 'pod_assignment', where: guarded((ids) => inSet('pod_id', ids.podIds)) },
      { table: 'pod_assignment_override', where: guarded((ids) => inSet('slot_id', ids.slotIds)) },
      { table: '"PodTutor"', where: guarded((ids) => inSet('"podId"', ids.podIds)) },
      { table: '"PodStudent"', where: guarded((ids) => inSet('"podId"', ids.podIds)) },
      { table: '"PodGroup"', where: guarded((ids) => inSet('"podId"', ids.podIds)) },
      { table: '"Pod"', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: '"SectionPeriodAssignment"', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      {
        table: '"ProgramSectionMapping"',
        // Reached ONLY through ProgramSchoolMapping (deleted next in the same
        // transaction) — the recount would self-blind; reported indirect.
        verify: 'indirect',
        where: guarded((ids) => {
          const c = inSet('"programId"', ids.programIds);
          return c === null ? null : `"schoolMappingId" IN (SELECT id FROM "ProgramSchoolMapping" WHERE ${c})`;
        }),
      },
      { table: '"ProgramSchoolMapping"', where: guarded((ids) => inSet('"programId"', ids.programIds)) },
      { table: '"Classroom"', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: '"RotationConfig"', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: '"RotationCalendarDay"', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: '"Cohort"', where: guarded((ids) => inSet('"periodId"', ids.periodIds)) },
      { table: '"TutoringPeriod"', where: guarded((ids) => inSet('"programId"', ids.programIds)) },
      { table: '"ProgramGroup"', where: guarded((ids) => inSet('"programId"', ids.programIds)) },
      { table: '"ProgramLink"', where: guarded((ids) => inSet('"programId"', ids.programIds)) },
      { table: '"ProgramFile"', where: guarded((ids) => inSet('"programId"', ids.programIds)) },
      { table: '"Program"', where: guarded((ids) => `"organizationId" = '${ids.orgId}'`) },
      { table: 'slot_projection', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'period_membership', projection: true, where: guarded((ids) => inSet('period_id', ids.periodIds)) },
      { table: 'cohort_membership', projection: true, where: guarded((ids) => inSet('cohort_id', ids.cohortIds)) },
      { table: 'pod_membership', projection: true, where: guarded((ids) => inSet('pod_id', ids.podIds)) },
      { table: 'program_membership', projection: true, where: guarded((ids) => inSet('program_id', ids.programIds)) },
      { table: 'program_section_resolution', projection: true, where: guarded((ids) => inSet('program_id', ids.programIds)) },
      { table: 'pod_tutor_projection', projection: true, where: guarded((ids) => inSet('pod_id', ids.podIds)) },
      { table: 'user_projection', projection: true, where: guarded((ids) => inSet('id', ids.userDelIds)) },
    ],
  },
  {
    key: 'ads-adm',
    service: 'ads-adm-api (student-data-system)',
    dbService: 'ads-adm-postgres',
    rules: [
      {
        // TEXT columns (branded strings) — literals are the same shape. The
        // iam_user_id disjunct is the belt-and-braces orphan sweep, SCOPED to
        // the org's periods: userDelIds membership is decided purely by iam
        // group_memberships, and enrollment paths that feed ADS do not require
        // an iam membership row in the owning org — unscoped, the disjunct
        // could reach OTHER orgs' attendance rows.
        table: 'adm_attendance',
        where: guarded((ids) => {
          const parts: string[] = [];
          const p = inSet('program_id', ids.programIds);
          if (p !== null) parts.push(p);
          const u = inSet('iam_user_id', ids.userDelIds);
          const per = inSet('period_id', ids.periodIds);
          if (u !== null && per !== null) parts.push(`(${u} AND ${per})`);
          return parts.length === 0 ? null : parts.join(' OR ');
        }),
      },
      // NO program_id column exists here — reachable via periodIds only.
      { table: 'period_attendance_status', where: guarded((ids) => inSet('period_id', ids.periodIds)) },
    ],
  },
  {
    key: 'coach',
    service: 'coach-api (coach)',
    rules: [
      // Cascades content_instance_module + content_instance_completed_module (real FKs).
      { table: 'content_instance', where: guarded((ids) => inSet('user_id', ids.userDelIds)) },
      // content_instance_id is a PLAIN column (no FK) — explicit delete by user.
      { table: 'module_answer', where: guarded((ids) => inSet('user_id', ids.userDelIds)) },
      {
        // The admin's org-row assignment mirrors the KEPT iam membership row
        // (iam_row_id = adminMembershipId) — coach projections never re-emit
        // for unchanged iam rows, so deleting it would break the admin's coach
        // persona permanently. Same protection as sessions' authz mirrors.
        table: 'persona_assignment',
        projection: true,
        where: guarded((ids) => {
          const parts: string[] = [];
          const u = inSet('user_id', ids.userDelIds);
          if (u !== null) parts.push(u);
          parts.push(`(group_id IN (${lit(ids.groupIds)}) AND iam_row_id IS DISTINCT FROM '${ids.adminMembershipId}')`);
          return parts.join(' OR ');
        }),
      },
      // Runtime config, not seed — the org row's mapping dies too (full G_ALL).
      { table: 'group_track_map', projection: true, where: guarded((ids) => `group_id IN (${lit(ids.groupIds)})`) },
    ],
  },
  {
    key: 'iam-pii',
    service: 'iam-pii (rostering, separate database)',
    rules: [
      {
        // No cross-DB FK — swept explicitly with userDelIds; admin belt-and-braces.
        table: 'user_pii',
        where: guarded((ids) => {
          const u = inSet('user_id', ids.userDelIds);
          return u === null ? null : `${u} AND user_id <> '${ids.adminUserId}'`;
        }),
      },
    ],
  },
  {
    key: 'iam',
    service: 'iam-api (rostering)',
    dbService: 'rostering-iam-canonical',
    rules: [
      {
        // MUST run before group_memberships dies — the membership rows are the
        // multi-org evidence. Cascades profiles/qualifications/auth_associations/
        // system_roles/memberships; user_policies.target_user_id SET NULLs.
        // Mirrors the userDelIds resolution exclusions exactly (multi-org,
        // env-wide actors, admin) so the cross-store sweeps agree with what
        // actually dies here. The recount uses the pre-resolved userDelIds
        // literal set — the subquery predicate would self-blind post-verify
        // (group_memberships dies in the same transaction).
        table: 'users',
        note: 'multi-org members, env-wide actors (non-USER role or any system role), and the admin survive',
        where: guarded(
          (ids) =>
            `id IN (SELECT DISTINCT gm.user_id FROM group_memberships gm WHERE gm.group_id IN (${lit(ids.groupIds)}))` +
            ` AND id <> '${ids.adminUserId}'` +
            ` AND NOT EXISTS (SELECT 1 FROM group_memberships gm2 WHERE gm2.user_id = users.id AND gm2.group_id NOT IN (${lit(ids.groupIds)}))` +
            ` AND users.role = 'USER'` +
            ` AND NOT EXISTS (SELECT 1 FROM user_system_roles usr WHERE usr.user_id = users.id)`,
        ),
        count: guarded((ids) => inSet('id', ids.userDelIds)),
      },
      {
        // Remaining org memberships of SURVIVING multi-org users; the admin's
        // seeded skeleton membership is kept by its deterministic id.
        table: 'group_memberships',
        where: guarded((ids) => `group_id IN (${lit(ids.groupIds)}) AND id <> '${ids.adminMembershipId}'`),
      },
      {
        // Seeded org personas (fixed catalog ids) are skeleton — kept, along with
        // whatever persona the kept admin membership references. Cascades
        // persona_permissions + persona_policies.
        table: 'personas',
        where: guarded((ids) => {
          const seeded = ids.seededPersonaIds.length > 0 ? ` AND id NOT IN (${lit(ids.seededPersonaIds)})` : '';
          return (
            `group_id IN (${lit(ids.groupIds)})${seeded}` +
            ` AND id NOT IN (SELECT persona_id FROM group_memberships WHERE id = '${ids.adminMembershipId}' AND persona_id IS NOT NULL)`
          );
        }),
      },
      // Explicit — the kept org row never cascades its children.
      { table: 'user_policies', where: guarded((ids) => `group_id IN (${lit(ids.groupIds)})`) },
      {
        // Org-row auth config is SEEDED config — excluded (child groups' rows die).
        table: 'group_auth_config',
        where: guarded((ids) => `group_id IN (${lit(ids.groupIds)}) AND group_id <> '${ids.orgId}'`),
      },
      {
        // Org-row login profile is seeded auth config — excluded, like its
        // siblings group_auth_config / group_attributes (child groups' die).
        table: 'login_profiles',
        where: guarded((ids) => `group_id IN (${lit(ids.groupIds)}) AND group_id <> '${ids.orgId}'`),
      },
      {
        // Org-row attributes (e.g. trackingMode) are seeded config — excluded.
        table: 'group_attributes',
        where: guarded((ids) => `group_id IN (${lit(ids.groupIds)}) AND group_id <> '${ids.orgId}'`),
      },
      // Child groups only — the org anchor row survives (the skeleton).
      { table: 'groups', where: guarded((ids) => `org_id = '${ids.orgId}' AND id <> '${ids.orgId}'`) },
    ],
  },
];

/** All store keys `env org reset --url` accepts (execution order). */
export const RESET_STORE_KEYS: string[] = RESET_STORES.map((s) => s.key);

/** One planned statement (kind is always 'delete' — resolution runs separately, cross-store). */
export interface ResetStatement {
  table: string;
  kind: 'delete' | 'resolve';
  sql: string;
  projection: boolean;
}

/** One table's planned delete + its matching (same-rows-at-plan-time) count query. */
export interface ResetTablePlan {
  table: string;
  projection: boolean;
  deleteSql: string | null;
  countSql: string | null;
  /** Post-verify cannot recount this table meaningfully (see ResetDeleteRule.verify). */
  verify?: 'indirect';
  skipped?: string;
  note?: string;
}

export interface StoreResetPlan {
  store: string;
  service: string;
  dbService?: string;
  tables: ResetTablePlan[];
  statements: ResetStatement[];
  /** BEGIN/COMMIT-wrapped compound of every applicable delete (ONE psql -c, all-or-nothing), or null. */
  transactionSql: string | null;
}

/**
 * Build every store's ordered, skeleton-protected delete plan from fully
 * resolved id-sets. Pure; validates every id before inlining anything.
 */
export function buildResetPlan(ids: ResetIdSets): StoreResetPlan[] {
  validateResetIds(ids);
  return RESET_STORES.map((store) => {
    const tables: ResetTablePlan[] = store.rules.map((rule) => {
      const where = rule.where(ids);
      if (where === null) {
        return {
          table: rule.table,
          projection: rule.projection === true,
          deleteSql: null,
          countSql: null,
          skipped: 'empty id-set',
          note: rule.note,
        };
      }
      const countWhere = rule.count === undefined ? where : rule.count(ids);
      return {
        table: rule.table,
        projection: rule.projection === true,
        deleteSql: `DELETE FROM ${rule.table} WHERE ${where}`,
        countSql: countWhere === null ? null : `SELECT count(*) FROM ${rule.table} WHERE ${countWhere}`,
        verify: rule.verify,
        note: rule.note,
      };
    });
    const statements: ResetStatement[] = tables
      .filter((t) => t.deleteSql !== null)
      .map((t) => ({ table: t.table, kind: 'delete' as const, sql: t.deleteSql as string, projection: t.projection }));
    const transactionSql =
      statements.length === 0 ? null : ['BEGIN', ...statements.map((s) => s.sql), 'COMMIT'].join(';\n') + ';';
    return { store: store.key, service: store.service, dbService: store.dbService, tables, statements, transactionSql };
  });
}

/**
 * Pre-flight identity + post-run skeleton probes (iam). The reset refuses to
 * run unless the org row IS the catalog org (display name) and the admin IS
 * the catalog admin (username = catalog email) — the belt-and-braces check
 * that the connected database really holds the seeded fixture org.
 */
export const RESET_GUARD_SQL = {
  orgRow: (orgId: string): string => {
    assertUuids([orgId], 'orgId');
    return `SELECT display_name FROM groups WHERE id = '${orgId}'`;
  },
  adminUser: (adminUserId: string): string => {
    assertUuids([adminUserId], 'adminUserId');
    return `SELECT username FROM users WHERE id = '${adminUserId}'`;
  },
  adminMembership: (adminMembershipId: string): string => {
    assertUuids([adminMembershipId], 'adminMembershipId');
    return `SELECT id FROM group_memberships WHERE id = '${adminMembershipId}'`;
  },
};
