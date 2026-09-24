// Shared dataset descriptors for the `rostering` external-source leg
// (IAM groups/memberships, the identity crosswalk, the Star-sync config
// dim). Source of truth: the exporter in the rostering repo imports
// these descriptors, and the lake renders `sources.yml` /
// `stage_landing_sources.sql` stanzas from the same objects — see the
// package README's "Shared dataset descriptors" section.
//
// Column contracts are copied from
// student-data-system/claude/projects/ledger-prod-lake/phase-4/dataset-catalog.md
// (the "rostering" section) — that catalog is the contract for columns
// and semantics; this file owns only the `LandingDataset` mechanics
// (the four structural columns, the Parquet/Athena type mapping,
// `requireStudentYearHash`). Edit the catalog first for a column change,
// then mirror it here.
//
// Person key: every `student_year_hash` here is
// `HMAC(salt, "{school_year}:{iam_user_id}")` — the same compound-key
// recipe as every other source in this package (see pseudonymise.ts).
// It covers students AND staff; `user_role` says which. Entity ids
// (org/district/school/section) stay raw — they are organisational, not
// personal (d217.1 2A), matching the existing `_app_` legs.

import {
  defineLandingDataset,
  requireStudentYearHash,
  type LandingDataset,
} from '../parquet-writer.js';

export type IamGroupRosteringRow = {
  school_year: string;
  source_system: 'rostering';
  group_id: string;
  parent_group_id: string | null;
  org_id: string;
  kind: string;
  display_name: string | null;
  status: string;
  source: string | null;
  source_id: string | null;
  created_at: Date;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/** One row per IAM group overlapping the school year. No student_year_hash — org-level, not personal. */
export const iamGroupRosteringDataset: LandingDataset<IamGroupRosteringRow> =
  defineLandingDataset<IamGroupRosteringRow>({
    name: 'iam_group_rostering',
    dataset: 'iam_group',
    sourceSystem: 'rostering',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'rostering' for this leg.",
      },
      {
        name: 'group_id',
        type: 'string',
        description: 'IAM group id, raw (organisational, not personal).',
      },
      {
        name: 'parent_group_id',
        type: 'string',
        optional: true,
        description:
          'Parent IAM group id in the containment tree, raw; null at the containment root.',
      },
      { name: 'org_id', type: 'string', description: 'Containment-root district group id, raw.' },
      {
        name: 'kind',
        type: 'string',
        description: 'Group kind: district|school|section|platform.',
      },
      {
        name: 'display_name',
        type: 'string',
        optional: true,
        description:
          'District/school/section display name in the clear (d217.1 2A gate); null for section/platform kinds.',
      },
      { name: 'status', type: 'string', description: 'Group lifecycle status.' },
      {
        name: 'source',
        type: 'string',
        optional: true,
        description:
          'Roster source system that created the group (e.g. Clever, OneRoster), when known.',
      },
      {
        name: 'source_id',
        type: 'string',
        optional: true,
        description: 'Clever/OneRoster sourcedId of the group, raw (organisational identifier).',
      },
      { name: 'created_at', type: 'timestamp', description: 'Group creation instant.' },
      { name: 'updated_at', type: 'timestamp', description: 'Group last-updated instant.' },
      { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['kind', 'parent_group_id', 'source_id'],
  });

export type IamGroupMembershipRosteringRow = {
  school_year: string;
  source_system: 'rostering';
  membership_id_hash: string;
  student_year_hash: string;
  group_id: string;
  group_kind: string;
  org_id: string;
  user_role: string | null;
  status: string;
  joined_at: Date;
  left_at: Date | null;
  inactive_at: Date | null;
  inactive_reason: string | null;
  inactive_caused_by_group_id: string | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * One row per membership *period* (not current state) — rows are
 * periods where `joined_at <= window_end AND (left_at IS NULL OR
 * left_at >= window_start)`. This table, not the `iam.events` topic, is
 * the complete history (the topic is purged at 90 days).
 */
export const iamGroupMembershipRosteringDataset: LandingDataset<IamGroupMembershipRosteringRow> =
  requireStudentYearHash(
    defineLandingDataset<IamGroupMembershipRosteringRow>({
      name: 'iam_group_membership_rostering',
      dataset: 'iam_group_membership',
      sourceSystem: 'rostering',
      columns: [
        {
          name: 'school_year',
          type: 'string',
          description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
        },
        {
          name: 'source_system',
          type: 'string',
          description: "Provenance literal — always 'rostering' for this leg.",
        },
        {
          name: 'membership_id_hash',
          type: 'string',
          description:
            'HMAC(salt, "iam_membership:{membership id}") — per-row audit/dedupe key, never the raw id.',
        },
        {
          name: 'student_year_hash',
          type: 'string',
          description:
            'HMAC(salt, "{school_year}:{iam_user_id}") — the compound person key (student or staff; see user_role).',
        },
        { name: 'group_id', type: 'string', description: 'IAM group id, raw.' },
        {
          name: 'group_kind',
          type: 'string',
          description: "Denormalised copy of the owning group's kind.",
        },
        { name: 'org_id', type: 'string', description: 'Containment-root district group id, raw.' },
        {
          name: 'user_role',
          type: 'string',
          optional: true,
          description: 'Persona role at time of membership: STUDENT|TUTOR|ADMIN|USER.',
        },
        { name: 'status', type: 'string', description: 'Membership status.' },
        {
          name: 'joined_at',
          type: 'timestamp',
          description: 'Instant the membership period began.',
        },
        {
          name: 'left_at',
          type: 'timestamp',
          optional: true,
          description: 'Instant the membership period ended, if it has.',
        },
        {
          name: 'inactive_at',
          type: 'timestamp',
          optional: true,
          description: 'Instant the membership was deactivated, if applicable.',
        },
        {
          name: 'inactive_reason',
          type: 'string',
          optional: true,
          description: 'EXPLICIT|CASCADE|USER_STATUS — why the membership was deactivated.',
        },
        {
          name: 'inactive_caused_by_group_id',
          type: 'string',
          optional: true,
          description:
            'Raw group id whose deactivation cascaded to this membership, when inactive_reason=CASCADE.',
        },
        {
          name: 'source',
          type: 'string',
          optional: true,
          description: 'Roster source system, when known.',
        },
        { name: 'created_at', type: 'timestamp', description: 'Membership row creation instant.' },
        {
          name: 'updated_at',
          type: 'timestamp',
          description: 'Membership row last-updated instant.',
        },
        { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
        { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
        { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
      ],
      fingerprint: ['membership_id_hash', 'inactive_reason', 'joined_at'],
    })
  );

export type IdentityCrosswalkRosteringRow = {
  school_year: string;
  source_system: 'rostering';
  student_year_hash: string;
  org_id: string;
  district_student_id_hash: string | null;
  district_student_id_source: string | null;
  district_student_id_available: boolean;
  external_user_id_hash: string | null;
  user_role: string;
  user_status: string;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * One row per user overlapping the school year — the bridge to
 * district/SIS ids. `district_student_id_hash` MUST be sourced from
 * `auth_associations.district_external_id` via `resolveDistrictExternalId()`
 * — NEVER `user_profiles.user_id_label` (rostering#1128; that path is
 * stale-by-construction). Deliberately absent: names, emails, username,
 * screen name, DOB, `user_id_label`, `user_pii.email_hash` (a live join
 * key into the PII store).
 */
export const identityCrosswalkRosteringDataset: LandingDataset<IdentityCrosswalkRosteringRow> =
  requireStudentYearHash(
    defineLandingDataset<IdentityCrosswalkRosteringRow>({
      name: 'identity_crosswalk_rostering',
      dataset: 'identity_crosswalk',
      sourceSystem: 'rostering',
      columns: [
        {
          name: 'school_year',
          type: 'string',
          description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
        },
        {
          name: 'source_system',
          type: 'string',
          description: "Provenance literal — always 'rostering' for this leg.",
        },
        {
          name: 'student_year_hash',
          type: 'string',
          description: 'HMAC(salt, "{school_year}:{iam_user_id}") — the compound person key.',
        },
        { name: 'org_id', type: 'string', description: 'Containment-root district group id, raw.' },
        {
          name: 'district_student_id_hash',
          type: 'string',
          optional: true,
          description:
            'HMAC(salt, "district_student_id:{trimmed district student number}") — sourced from ' +
            'auth_associations.district_external_id via resolveDistrictExternalId(); NEVER ' +
            'user_profiles.user_id_label (rostering#1128).',
        },
        {
          name: 'district_student_id_source',
          type: 'string',
          optional: true,
          description:
            'Provider/sourceType that carried the district id: CLEVER|ONE_ROSTER|MANUAL|CSV.',
        },
        {
          name: 'district_student_id_available',
          type: 'boolean',
          description: 'Whether a district student id was resolvable for this user.',
        },
        {
          name: 'external_user_id_hash',
          type: 'string',
          optional: true,
          description:
            'HMAC(salt, "saga_external_user:{external_user_id}") — reuses the existing namespace; only ' +
            "populated where a district's Star join is configured on EXTERNAL_USER_ID.",
        },
        {
          name: 'user_role',
          type: 'string',
          description: 'Persona role: STUDENT|TUTOR|ADMIN|USER.',
        },
        { name: 'user_status', type: 'string', description: 'User account status.' },
        { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
        { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
        { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
      ],
      fingerprint: ['district_student_id_available', 'district_student_id_source'],
    })
  );

export type DistrictSyncConfigRosteringRow = {
  school_year: string;
  source_system: 'rostering';
  org_id: string;
  star_join_star_column: string | null;
  star_join_sis_field: string | null;
  star_join_fallback: string;
  star_roster_source: string | null;
  oneroster_enabled: boolean;
  clever_enabled: boolean;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * One row per district — the config dim backing the Star import join.
 * No student_year_hash (org-level config, not personal). Dropped:
 * `clever_credentials`, `digest_recipients`, cursors.
 */
export const districtSyncConfigRosteringDataset: LandingDataset<DistrictSyncConfigRosteringRow> =
  defineLandingDataset<DistrictSyncConfigRosteringRow>({
    name: 'district_sync_config_rostering',
    dataset: 'district_sync_config',
    sourceSystem: 'rostering',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'rostering' for this leg.",
      },
      { name: 'org_id', type: 'string', description: 'Containment-root district group id, raw.' },
      {
        name: 'star_join_star_column',
        type: 'string',
        optional: true,
        description: 'Which Star export column the district configures the Star join on.',
      },
      {
        name: 'star_join_sis_field',
        type: 'string',
        optional: true,
        description: 'Which SIS field the district configures the Star join on.',
      },
      {
        name: 'star_join_fallback',
        type: 'string',
        description: 'Fallback join strategy when the primary join misses.',
      },
      {
        name: 'star_roster_source',
        type: 'string',
        optional: true,
        description: 'Roster source the Star import reads from for this district.',
      },
      {
        name: 'oneroster_enabled',
        type: 'boolean',
        description: 'Whether OneRoster sync is enabled for this district.',
      },
      {
        name: 'clever_enabled',
        type: 'boolean',
        description: 'Whether Clever sync is enabled for this district.',
      },
      { name: 'updated_at', type: 'timestamp', description: 'Config row last-updated instant.' },
      { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['star_join_star_column', 'star_roster_source'],
  });
