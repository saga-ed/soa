/**
 * Org data-footprint model for the `ss env org` commands (soa#355) — PURE.
 *
 * Encodes, per Postgres store in the mesh, which tables hold org-linked rows
 * and by which id parameter they are reached. Org identity anchors in exactly
 * two columns fleet-wide (iam `groups.org_id`, programs `Program."organizationId"`);
 * everything else is TRANSITIVE via resolved id-sets (group ids → member user
 * ids → program ids). `projection: true` marks event-materialized rows (the
 * orphan category): projections never self-heal, so `org status` counts them
 * separately and a reset must sweep them by the SAME id-sets.
 *
 * Table/column names are verified against the owning repos' prisma schemas
 * (rostering iam-db, program-hub programs/scheduling/sessions, sds ads-adm-db,
 * coach-db) as of 2026-07-21 — each StoreDef notes its schema source. The map
 * is the ANCHOR + FIRST-RING footprint, deliberately extensible: growing it is
 * a reviewed code change, and `env org status` prints per-table provenance so
 * a missing table is visible, not silent.
 *
 * SQL SAFETY: ids are interpolated as literals (psql shell-out has no bind
 * params), so every id MUST pass `assertUuids` first — derived catalog ids do
 * by construction; live-resolved ids are validated before reuse.
 */

/**
 * Which resolved id-set a table's rows are reached by. The first four are the
 * Phase-0 sets `org status` resolves live; the deeper rings (periodIds, …) are
 * resolved by Phase 1's reset — a footprint rule keyed on a set the caller has
 * not resolved is reported as skipped, never silently mis-counted.
 */
export type IdParamKind =
  | 'orgId'
  | 'groupIds'
  | 'userIds'
  | 'programIds'
  | 'periodIds'
  | 'cohortIds'
  | 'podIds'
  | 'slotIds'
  | 'scheduleIds';

export interface TableRule {
  /** Table name as it exists in the database (schema-qualified if not public). */
  table: string;
  /** The id parameter this table is filtered by. */
  param: IdParamKind;
  /** The column matched against the parameter. */
  column: string;
  /** Event-materialized row (projection/mirror) — the orphan category. */
  projection?: boolean;
  note?: string;
}

export interface StoreDef {
  /** Store key used in `--url <key>=<conn>` overrides and output. */
  key: string;
  /** Owning deployable (for humans). */
  service: string;
  /**
   * ECS service-name prefix in the shared cluster; the deployed instance is
   * `<ecsService>-<ledgerIdentifier>` (e.g. `rostering-iam-api-main` on dev,
   * `rostering-iam-api-training` on training). `env connect` resolves the DB
   * target from THIS service's live task definition.
   */
  ecsService: string;
  engine: 'postgres';
  /** Logical database name hint (authoritative names come from live discovery). */
  database: string;
  /** Where the table map was verified from. */
  schemaSource: string;
  tables: TableRule[];
}

/** The resolved id-sets an org footprint is computed from (deep rings optional — Phase 1). */
export interface OrgIdSets {
  orgId: string;
  groupIds: string[];
  userIds: string[];
  programIds: string[];
  periodIds?: string[];
  cohortIds?: string[];
  podIds?: string[];
  slotIds?: string[];
  scheduleIds?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id inlined into SQL must be a well-formed UUID — throws otherwise. */
export function assertUuids(ids: readonly string[], label: string): void {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`${label}: '${id}' is not a UUID — refusing to build SQL with it`);
  }
}

export const STORES: StoreDef[] = [
  {
    key: 'iam',
    ecsService: 'rostering-iam-api',
    service: 'iam-api (rostering)',
    engine: 'postgres',
    database: 'iam',
    schemaSource: 'rostering/packages/node/iam-db/src/prisma/schema.prisma',
    tables: [
      { table: 'groups', param: 'orgId', column: 'org_id', note: 'THE org anchor — district/school/section rows' },
      { table: 'group_memberships', param: 'groupIds', column: 'group_id' },
      { table: 'user_policies', param: 'groupIds', column: 'group_id' },
      { table: 'users', param: 'userIds', column: 'id', note: 'users are NOT org-scoped — only members resolved via memberships; seed-protected rows excluded at reset' },
      // audit_logs is append-only by DB rule — deliberately absent.
    ],
  },
  {
    key: 'programs',
    ecsService: 'program-hub-programs-api',
    service: 'programs-api (program-hub)',
    engine: 'postgres',
    database: 'programs',
    schemaSource: 'program-hub/apps/node/programs-api/src/prisma/schema.prisma',
    tables: [
      { table: '"Program"', param: 'orgId', column: '"organizationId"', note: 'the second org anchor' },
      // Pod/pod_assignment are period/cohort-keyed (a deeper ring) — Phase 1's
      // resolver adds periodIds/podIds before they can be counted here.
      { table: 'program_membership', param: 'programIds', column: 'program_id' },
      { table: 'user_projection', param: 'userIds', column: 'id', projection: true, note: 'iam mirror' },
    ],
  },
  {
    key: 'scheduling',
    ecsService: 'program-hub-scheduling-api',
    service: 'scheduling-api (program-hub)',
    engine: 'postgres',
    database: 'scheduling',
    schemaSource: 'program-hub/apps/node/scheduling-api/src/prisma/schema.prisma',
    tables: [
      { table: 'program_projection', param: 'orgId', column: 'organization_id', projection: true },
      { table: 'period_projection', param: 'programIds', column: 'program_id', projection: true },
    ],
  },
  {
    key: 'sessions',
    ecsService: 'program-hub-sessions-api',
    service: 'sessions-api (program-hub)',
    engine: 'postgres',
    database: 'sessions',
    schemaSource: 'program-hub/apps/node/sessions-api/src/prisma/schema.prisma',
    tables: [
      { table: 'tutoring_session', param: 'programIds', column: 'program_id' },
      { table: 'schedule_projection', param: 'programIds', column: 'program_id', projection: true },
      // projection_readiness is a parity-critical singleton — never org-scoped, never touched.
    ],
  },
  {
    key: 'ads-adm',
    ecsService: 'sds-ads-adm-api',
    service: 'ads-adm-api (student-data-system)',
    engine: 'postgres',
    database: 'ads_adm',
    schemaSource: 'student-data-system/packages/node/ads-adm-db/src/prisma/schema.prisma',
    tables: [
      { table: 'adm_attendance', param: 'programIds', column: 'program_id' },
      // CORRECTED 2026-07-21: this table has NO program_id column (only
      // period_id/date/state/…) — reachable via periodIds, which `org status`
      // does not resolve (reported skipped) and Phase 1's reset does.
      { table: 'period_attendance_status', param: 'periodIds', column: 'period_id' },
    ],
  },
  {
    key: 'coach',
    ecsService: 'coach-coach-api',
    service: 'coach-api (coach)',
    engine: 'postgres',
    database: 'coach',
    schemaSource: 'coach/packages/node/coach-db/src/prisma/schema.prisma',
    tables: [
      { table: 'content_instance', param: 'userIds', column: 'user_id' },
      { table: 'module_answer', param: 'userIds', column: 'user_id' },
      { table: 'persona_assignment', param: 'userIds', column: 'user_id', projection: true, note: 'converges from IAM replay' },
      { table: 'group_track_map', param: 'groupIds', column: 'group_id', projection: true },
    ],
  },
];

/** The id-resolution SQL run against the two anchor stores (live resolution). */
export const RESOLVE_SQL = {
  /** iam: the org's group ids (district row included — org_id is self for the district). */
  groupIds: (orgId: string): string => {
    assertUuids([orgId], 'orgId');
    return `SELECT id FROM groups WHERE org_id = '${orgId}'`;
  },
  /** iam: user ids reachable from the org's groups. */
  userIds: (groupIds: readonly string[]): string => {
    assertUuids(groupIds, 'groupIds');
    return `SELECT DISTINCT user_id FROM group_memberships WHERE group_id IN (${inList(groupIds)})`;
  },
  /** programs: the org's program ids. */
  programIds: (orgId: string): string => {
    assertUuids([orgId], 'orgId');
    return `SELECT id FROM "Program" WHERE "organizationId" = '${orgId}'`;
  },
};

const inList = (ids: readonly string[]): string => ids.map((id) => `'${id}'`).join(', ');

/** COUNT query for one table rule against resolved id-sets; null when the param set is empty/unresolved (count is trivially 0/unknowable). */
export function countSql(rule: TableRule, ids: OrgIdSets): string | null {
  const param = ids[rule.param];
  if (param === undefined) return null;
  if (typeof param === 'string') {
    assertUuids([param], rule.param);
    return `SELECT count(*) FROM ${rule.table} WHERE ${rule.column} = '${param}'`;
  }
  if (param.length === 0) return null;
  assertUuids(param, rule.param);
  return `SELECT count(*) FROM ${rule.table} WHERE ${rule.column} IN (${inList(param)})`;
}

/** One store's footprint rows for display/JSON. */
export interface StoreFootprint {
  store: string;
  service: string;
  tables: { table: string; projection: boolean; count: number | null; skipped?: string }[];
}
