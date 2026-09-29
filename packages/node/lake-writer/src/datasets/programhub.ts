// Shared dataset descriptors for the `programhub` external-source leg
// (programs, periods, pods, the composed session/roster facts). Source
// of truth: the exporter in program-hub imports these descriptors, and
// the lake renders `sources.yml` / `stage_landing_sources.sql` stanzas
// from the same objects — see the package README's "Shared dataset
// descriptors" section.
//
// Column contracts are copied from
// student-data-system/claude/projects/ledger-prod-lake/phase-4/dataset-catalog.md
// (the "programhub" section) — that catalog is the contract for columns
// and semantics; this file owns only the `LandingDataset` mechanics.
// Edit the catalog first for a column change, then mirror it here.
//
// Seven datasets (do not add an eighth): program, program_school_mapping,
// program_period, program_pod, pod_membership, session_occurrence,
// session_participant. Entity ids (program/period/pod/organization) stay
// raw — organisational, not personal (d217.1 2A). Names land in the
// clear under the same gate, EXCEPT pod/cohort names, which are dropped
// (small cells, often tutor-named).

import {
  defineLandingDataset,
  requireStudentYearHash,
  type LandingDataset,
} from '../parquet-writer.js';

export type ProgramProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  program_id: string;
  organization_id: string;
  name: string | null;
  timezone: string;
  schedule_start_date: string | null;
  schedule_end_date: string | null;
  max_student_enrollment: number | null;
  max_tutor_allocation: number | null;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/** One row per program overlapping the school year. No student_year_hash — program-level, not personal. */
export const programProgramhubDataset: LandingDataset<ProgramProgramhubRow> =
  defineLandingDataset<ProgramProgramhubRow>({
    name: 'program_programhub',
    dataset: 'program',
    sourceSystem: 'programhub',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'programhub' for this leg.",
      },
      { name: 'program_id', type: 'string', description: 'Program id, raw.' },
      {
        name: 'organization_id',
        type: 'string',
        description: 'District group id, raw (organisational).',
      },
      {
        name: 'name',
        type: 'string',
        optional: true,
        description: 'Program display name in the clear (d217.1 2A gate).',
      },
      { name: 'timezone', type: 'string', description: "Program's configured timezone." },
      {
        name: 'schedule_start_date',
        type: 'string',
        optional: true,
        description:
          "YYYY-MM-DD from scheduling's Schedule; nullable/unvalidated — provenance only.",
      },
      {
        name: 'schedule_end_date',
        type: 'string',
        optional: true,
        description:
          "YYYY-MM-DD from scheduling's Schedule; nullable/unvalidated — provenance only.",
      },
      {
        name: 'max_student_enrollment',
        type: 'int64',
        optional: true,
        description: 'Configured student enrollment cap.',
      },
      {
        name: 'max_tutor_allocation',
        type: 'int64',
        optional: true,
        description: 'Configured tutor allocation cap.',
      },
      {
        name: 'version',
        type: 'int64',
        description: 'Optimistic-concurrency version of the program row.',
      },
      {
        name: 'deleted_at',
        type: 'timestamp',
        optional: true,
        description: 'Soft-delete instant, if deleted.',
      },
      { name: 'created_at', type: 'timestamp', description: 'Program creation instant.' },
      { name: 'updated_at', type: 'timestamp', description: 'Program last-updated instant.' },
      { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['organization_id', 'timezone', 'schedule_start_date'],
  });

export type ProgramSchoolMappingProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  program_id: string;
  school_group_id: string;
  enrolled: boolean;
  child_policy: string | null;
  created_at: Date;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/** One row per (program, school) mapping overlapping the school year. No student_year_hash. */
export const programSchoolMappingProgramhubDataset: LandingDataset<ProgramSchoolMappingProgramhubRow> =
  defineLandingDataset<ProgramSchoolMappingProgramhubRow>({
    name: 'program_school_mapping_programhub',
    dataset: 'program_school_mapping',
    sourceSystem: 'programhub',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'programhub' for this leg.",
      },
      { name: 'program_id', type: 'string', description: 'Program id, raw.' },
      { name: 'school_group_id', type: 'string', description: 'School IAM group id, raw.' },
      {
        name: 'enrolled',
        type: 'boolean',
        description: 'Whether the school is currently enrolled in the program.',
      },
      {
        name: 'child_policy',
        type: 'string',
        optional: true,
        description: 'Policy governing whether sub-groups of this school inherit the mapping.',
      },
      { name: 'created_at', type: 'timestamp', description: 'Mapping row creation instant.' },
      { name: 'updated_at', type: 'timestamp', description: 'Mapping row last-updated instant.' },
      { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['school_group_id', 'child_policy'],
  });

export type ProgramPeriodProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  period_id: string;
  program_id: string;
  name: string | null;
  sort_order: number;
  rotation_count: number;
  rotation_pattern: string;
  student_tutor_ratio: number;
  is_ad_hoc_bucket: boolean;
  cohort_count: number;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/** One row per period overlapping the school year. No student_year_hash — period-level, not personal. */
export const programPeriodProgramhubDataset: LandingDataset<ProgramPeriodProgramhubRow> =
  defineLandingDataset<ProgramPeriodProgramhubRow>({
    name: 'program_period_programhub',
    dataset: 'program_period',
    sourceSystem: 'programhub',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'programhub' for this leg.",
      },
      { name: 'period_id', type: 'string', description: 'Period id, raw.' },
      { name: 'program_id', type: 'string', description: 'Program id, raw.' },
      {
        name: 'name',
        type: 'string',
        optional: true,
        description: 'Period display name in the clear (d217.1 2A gate) — grade labels live here.',
      },
      {
        name: 'sort_order',
        type: 'int64',
        description: 'Display sort order among sibling periods.',
      },
      {
        name: 'rotation_count',
        type: 'int64',
        description: 'Number of rotations configured for this period.',
      },
      { name: 'rotation_pattern', type: 'string', description: "Period's rotation pattern." },
      {
        name: 'student_tutor_ratio',
        type: 'int64',
        description: 'Configured student-to-tutor ratio.',
      },
      {
        name: 'is_ad_hoc_bucket',
        type: 'boolean',
        description: 'Whether this period is the ad-hoc bucket.',
      },
      {
        name: 'cohort_count',
        type: 'int64',
        description: 'Number of cohorts configured for this period.',
      },
      {
        name: 'version',
        type: 'int64',
        description: 'Optimistic-concurrency version of the period row.',
      },
      {
        name: 'deleted_at',
        type: 'timestamp',
        optional: true,
        description: 'Soft-delete instant, if deleted.',
      },
      { name: 'created_at', type: 'timestamp', description: 'Period creation instant.' },
      { name: 'updated_at', type: 'timestamp', description: 'Period last-updated instant.' },
      { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['rotation_pattern', 'student_tutor_ratio', 'is_ad_hoc_bucket'],
  });

export type ProgramPodProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  pod_id: string;
  period_id: string;
  cohort_id: string | null;
  program_id: string;
  rotation: number | null;
  treatment_kind: string | null;
  no_tutor_required: boolean;
  is_ad_hoc: boolean;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * One row per pod overlapping the school year. No student_year_hash —
 * pod-level, not personal. Dropped: `name`, `activity_type`, classroom,
 * `idempotency_key`, rostering group ids.
 */
export const programPodProgramhubDataset: LandingDataset<ProgramPodProgramhubRow> =
  defineLandingDataset<ProgramPodProgramhubRow>({
    name: 'program_pod_programhub',
    dataset: 'program_pod',
    sourceSystem: 'programhub',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'programhub' for this leg.",
      },
      { name: 'pod_id', type: 'string', description: 'Pod id, raw.' },
      { name: 'period_id', type: 'string', description: 'Period id, raw.' },
      {
        name: 'cohort_id',
        type: 'string',
        optional: true,
        description: 'Cohort id, raw, when the pod belongs to one.',
      },
      { name: 'program_id', type: 'string', description: 'Program id, raw.' },
      {
        name: 'rotation',
        type: 'int64',
        optional: true,
        description: 'Rotation index this pod occupies, when rotating.',
      },
      {
        name: 'treatment_kind',
        type: 'string',
        optional: true,
        description: 'Via the non-deleted pod_assignment row, when present.',
      },
      {
        name: 'no_tutor_required',
        type: 'boolean',
        description: 'Whether this pod is configured to run without a tutor.',
      },
      { name: 'is_ad_hoc', type: 'boolean', description: 'Whether this pod was created ad hoc.' },
      {
        name: 'version',
        type: 'int64',
        description: 'Optimistic-concurrency version of the pod row.',
      },
      {
        name: 'deleted_at',
        type: 'timestamp',
        optional: true,
        description: 'Soft-delete instant, if deleted.',
      },
      { name: 'created_at', type: 'timestamp', description: 'Pod creation instant.' },
      { name: 'updated_at', type: 'timestamp', description: 'Pod last-updated instant.' },
      { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['treatment_kind', 'no_tutor_required', 'is_ad_hoc'],
  });

export type PodMembershipProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  student_year_hash: string;
  pod_id: string;
  period_id: string;
  program_id: string;
  role: string;
  membership_source: string | null;
  valid_from: Date;
  valid_until: Date | null;
  app_record_id_hash: string;
  snapshot_at: Date;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * Resolved interval roster including tutors (table snapshot, no
 * composition) — rows are intervals overlapping the school-year window.
 */
export const podMembershipProgramhubDataset: LandingDataset<PodMembershipProgramhubRow> =
  requireStudentYearHash(
    defineLandingDataset<PodMembershipProgramhubRow>({
      name: 'pod_membership_programhub',
      dataset: 'pod_membership',
      sourceSystem: 'programhub',
      columns: [
        {
          name: 'school_year',
          type: 'string',
          description: 'SYxx-yy snapshot school year (Aug-1 UTC rule).',
        },
        {
          name: 'source_system',
          type: 'string',
          description: "Provenance literal — always 'programhub' for this leg.",
        },
        {
          name: 'student_year_hash',
          type: 'string',
          description:
            'HMAC(salt, "{school_year}:{iam_user_id}") — the compound person key (student or tutor; see role).',
        },
        { name: 'pod_id', type: 'string', description: 'Pod id, raw.' },
        { name: 'period_id', type: 'string', description: 'Period id, raw.' },
        { name: 'program_id', type: 'string', description: 'Program id, raw.' },
        {
          name: 'role',
          type: 'string',
          description: 'SCHOLAR (from pod_membership) or TUTOR (from pod_tutor_projection).',
        },
        {
          name: 'membership_source',
          type: 'string',
          optional: true,
          description: 'EXPLICIT|SECTION_ENROLLMENT|USER_STATUS.',
        },
        {
          name: 'valid_from',
          type: 'timestamp',
          description: 'Instant this membership interval began.',
        },
        {
          name: 'valid_until',
          type: 'timestamp',
          optional: true,
          description: 'Instant this membership interval ended, if it has.',
        },
        {
          name: 'app_record_id_hash',
          type: 'string',
          description:
            'HMAC(salt, "ph_participant:{pod_id}:{user_id}:{role}:{valid_from}") — composite per-row audit/dedupe key.',
        },
        { name: 'snapshot_at', type: 'timestamp', description: 'Instant this snapshot was taken.' },
        { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
        { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
      ],
      fingerprint: ['valid_until', 'membership_source', 'pod_id'],
    })
  );

export type SessionOccurrenceProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  session_id_hash: string;
  date: string;
  program_id: string;
  organization_id: string;
  period_id: string;
  cohort_id: string | null;
  slot_id: string | null;
  pod_id: string;
  effective_pod_id: string | null;
  origin: string;
  treatment_kind: string | null;
  status: string | null;
  timezone: string;
  intended_start_instant: Date | null;
  intended_end_instant: Date | null;
  actual_start: Date | null;
  actual_end: Date | null;
  cancelled_at: Date | null;
  cancellation_source: string | null;
  cancellation_actor: string | null;
  has_lifecycle_row: boolean;
  participant_count: number;
  host_count: number;
  created_at: Date | null;
  updated_at: Date | null;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * One row per composed occurrence (date x period x slot x pod);
 * school_year is derived per row from `date`, so this dataset carries no
 * `snapshot_at` (occurrence-grain, not snapshot-grain). No
 * student_year_hash — occurrence-level, not personal (see
 * session_participant_programhub for the person-grain roster).
 *
 * `tutoring_session` rows are written lazily on first fact, so a
 * `--since` on `updated_at` misses untouched scheduled occurrences — the
 * honest export is a full re-expansion per (program, date-range) per run.
 */
export const sessionOccurrenceProgramhubDataset: LandingDataset<SessionOccurrenceProgramhubRow> =
  defineLandingDataset<SessionOccurrenceProgramhubRow>({
    name: 'session_occurrence_programhub',
    dataset: 'session_occurrence',
    sourceSystem: 'programhub',
    columns: [
      {
        name: 'school_year',
        type: 'string',
        description: 'Derived per row from `date` (Aug-1 UTC rule).',
      },
      {
        name: 'source_system',
        type: 'string',
        description: "Provenance literal — always 'programhub' for this leg.",
      },
      {
        name: 'session_id_hash',
        type: 'string',
        description:
          'HMAC(salt, "ph_session:{tutoring_session.id}") — per-occurrence audit/dedupe key.',
      },
      {
        name: 'date',
        type: 'string',
        description: "YYYY-MM-DD occurrence date; source of this row's school_year.",
      },
      { name: 'program_id', type: 'string', description: 'Program id, raw.' },
      { name: 'organization_id', type: 'string', description: 'District group id, raw.' },
      { name: 'period_id', type: 'string', description: 'Period id, raw.' },
      {
        name: 'cohort_id',
        type: 'string',
        optional: true,
        description: 'Cohort id, raw, when applicable.',
      },
      {
        name: 'slot_id',
        type: 'string',
        optional: true,
        description: 'Slot id, raw, when applicable.',
      },
      { name: 'pod_id', type: 'string', description: 'Pod id, raw.' },
      {
        name: 'effective_pod_id',
        type: 'string',
        optional: true,
        description: 'Pod id actually serving the occurrence, when it differs from pod_id.',
      },
      { name: 'origin', type: 'string', description: 'rule|manual_addition|period_meeting.' },
      {
        name: 'treatment_kind',
        type: 'string',
        optional: true,
        description: 'Treatment kind for this occurrence, when set.',
      },
      {
        name: 'status',
        type: 'string',
        optional: true,
        description: 'NotStarted|Started|Ended; null when no lifecycle row exists.',
      },
      { name: 'timezone', type: 'string', description: "Occurrence's configured timezone." },
      {
        name: 'intended_start_instant',
        type: 'timestamp',
        optional: true,
        description: 'Scheduled start instant.',
      },
      {
        name: 'intended_end_instant',
        type: 'timestamp',
        optional: true,
        description: 'Scheduled end instant.',
      },
      {
        name: 'actual_start',
        type: 'timestamp',
        optional: true,
        description: 'Actual start instant, from the lifecycle row.',
      },
      {
        name: 'actual_end',
        type: 'timestamp',
        optional: true,
        description: 'Actual end instant, from the lifecycle row.',
      },
      {
        name: 'cancelled_at',
        type: 'timestamp',
        optional: true,
        description: 'Cancellation instant, if cancelled.',
      },
      {
        name: 'cancellation_source',
        type: 'string',
        optional: true,
        description: 'What cancelled the occurrence.',
      },
      {
        name: 'cancellation_actor',
        type: 'string',
        optional: true,
        description: 'Raw actor id/role that cancelled the occurrence, not a name.',
      },
      {
        name: 'has_lifecycle_row',
        type: 'boolean',
        description: 'Whether a lifecycle (start/end/cancel) row exists for this occurrence.',
      },
      {
        name: 'participant_count',
        type: 'int64',
        description: 'Composed participant count for this occurrence.',
      },
      {
        name: 'host_count',
        type: 'int64',
        description: 'Composed host (tutor) count for this occurrence.',
      },
      {
        name: 'created_at',
        type: 'timestamp',
        optional: true,
        description: 'tutoring_session row creation instant, when it exists.',
      },
      {
        name: 'updated_at',
        type: 'timestamp',
        optional: true,
        description: 'tutoring_session row last-updated instant, when it exists.',
      },
      { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
      { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
    ],
    fingerprint: ['effective_pod_id', 'has_lifecycle_row', 'cancellation_source'],
  });

export type SessionParticipantProgramhubRow = {
  school_year: string;
  source_system: 'programhub';
  session_id_hash: string;
  date: string;
  program_id: string;
  period_id: string;
  pod_id: string;
  student_year_hash: string;
  role: string;
  origin: string;
  was_removed_by_override: boolean;
  membership_source: string | null;
  asof: Date;
  app_record_id_hash: string;
  ingest_run_id: string;
  ingested_at: Date;
};

/**
 * One row per occurrence x person — the composed roster, delta applied.
 * There is no durable per-occurrence participant table and
 * `sess.session.resolved.v1` is deliberately not published; the exporter
 * must re-run composition in-process (the `resolveOccurrencesForAttendance`
 * fold: `(base - removed) + added`, hosts -> TUTOR) and keep removed rows
 * flagged (`was_removed_by_override`) rather than dropping them.
 * `asof` — the instant the roster was resolved at — is load-bearing
 * since membership is interval-modelled. No `snapshot_at` — occurrence
 * grain, like session_occurrence_programhub.
 */
export const sessionParticipantProgramhubDataset: LandingDataset<SessionParticipantProgramhubRow> =
  requireStudentYearHash(
    defineLandingDataset<SessionParticipantProgramhubRow>({
      name: 'session_participant_programhub',
      dataset: 'session_participant',
      sourceSystem: 'programhub',
      columns: [
        {
          name: 'school_year',
          type: 'string',
          description: 'Derived per row from `date` (Aug-1 UTC rule).',
        },
        {
          name: 'source_system',
          type: 'string',
          description: "Provenance literal — always 'programhub' for this leg.",
        },
        {
          name: 'session_id_hash',
          type: 'string',
          description:
            'HMAC(salt, "ph_session:{tutoring_session.id}") — joins to session_occurrence_programhub.',
        },
        { name: 'date', type: 'string', description: 'YYYY-MM-DD occurrence date.' },
        { name: 'program_id', type: 'string', description: 'Program id, raw.' },
        { name: 'period_id', type: 'string', description: 'Period id, raw.' },
        { name: 'pod_id', type: 'string', description: 'Pod id, raw.' },
        {
          name: 'student_year_hash',
          type: 'string',
          description:
            'HMAC(salt, "{school_year}:{iam_user_id}") — the compound person key (student or tutor; see role).',
        },
        { name: 'role', type: 'string', description: 'SCHOLAR|TUTOR.' },
        { name: 'origin', type: 'string', description: 'base|override_added|override_host.' },
        {
          name: 'was_removed_by_override',
          type: 'boolean',
          description:
            'True when this row was removed from the composed roster by an override; kept, not dropped.',
        },
        {
          name: 'membership_source',
          type: 'string',
          optional: true,
          description: 'EXPLICIT|SECTION_ENROLLMENT|USER_STATUS.',
        },
        {
          name: 'asof',
          type: 'timestamp',
          description:
            'Instant the roster was resolved at — load-bearing; membership is interval-modelled.',
        },
        {
          name: 'app_record_id_hash',
          type: 'string',
          description:
            'HMAC(salt, "ph_participant:{session_id}:{user_id}:{role}") — per-row audit/dedupe key.',
        },
        { name: 'ingest_run_id', type: 'string', description: 'Export run id.' },
        { name: 'ingested_at', type: 'timestamp', description: 'Export run instant.' },
      ],
      fingerprint: ['was_removed_by_override', 'asof', 'origin'],
    })
  );
