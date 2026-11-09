/**
 * The mirror → local database map (`ss stack hydrate`).
 *
 * The daily prod MIRROR (dev account, RDS `saga-postgres-mirror-current-*`,
 * re-created 13:30 UTC) carries 17 databases whose names DO NOT match the
 * synthetic stack's. Only `coach_api`, `sis_db` and `openfga` share a name;
 * everything else is a real mapping (`programs_api` → `programs`,
 * `iam_db` → `iam_local`, `ledger_api` → `ledger_local`, …). Getting one wrong
 * restores one service's schema over another service's database, so the map is
 * DATA here — pure, reviewable, unit-tested — never inlined in the command.
 *
 * `local` is a manifest `DbId`, so the local NAME and the local OWNER ROLE are
 * read from `core/manifest/databases.ts` (one source of truth) rather than
 * duplicated here. A unit test asserts every `local` resolves.
 *
 * THE SCRUB (`scrubbed: true`) — the central structural fact. The daily cron
 * scrubs the projects in hipponot/iac `postgres_mirror_to_dev.yml`
 * `SCHEDULED_SCRUB_PROJECTS` (rostering, program-hub, student-data-system,
 * coach as of 2026-11-09). In a scrubbed database the real table is renamed
 * `{table}_real` and a scrambled VIEW takes the original name, which is why both
 * source modes need a rename step (see `core/mirror/plan.ts`).
 *
 * `scrubbed` was checked against each database's catalog on 2026-11-09, not
 * inferred from the project list: `openfga` has rules but no swapped table, so
 * it is the one mapping with `scrubbed: false`. An executing hydrate re-checks
 * this against the live catalog and refuses if the two disagree.
 */

import { getDb } from '../manifest/index.js';
import type { DbId, Manifest } from '../manifest/index.js';

/**
 * Which copy of a scrubbed database's data to land locally.
 *
 * DEFAULT IS `scrubbed` — a DATA-CLASSIFICATION decision, not a convenience.
 * Prod holds real district students, so `{t}_real` is raw student data. `real`
 * lands exactly that on a developer machine and is never the recommended mode.
 */
export type SourceMode = 'real' | 'scrubbed';

/** iac's `SCHEDULED_SCRUB_PROJECTS` (`postgres_mirror_to_dev.yml`), as of 2026-11-09. */
export const SCRUB_PROJECTS = ['rostering', 'program-hub', 'student-data-system', 'coach'] as const;
export type ScrubProject = (typeof SCRUB_PROJECTS)[number];

/** One mirror database and where it lands in a local slot. */
export interface MirrorDbDef {
  /** Database name IN THE MIRROR (prod's name). */
  mirror: string;
  /** Local manifest database id (the local name + owner role come from the manifest). */
  local: DbId;
  /**
   * Is this database view-swapped by the daily scrub (real tables renamed
   * `{t}_real`, a scrambled VIEW at `{t}`)? Measured from the mirror's catalog.
   */
  scrubbed: boolean;
  /** The iac scrub project whose rules package owns this database. */
  scrubProject: ScrubProject;
  /** Included when `--db` is omitted. */
  inDefaultSet: boolean;
  /** Why it is (or is not) in the default set — surfaced in `--help` and the docs. */
  note?: string;
}

/**
 * The 15 app databases in the mirror, largest first (the order hydrate reports
 * in, so the slow ones are visible early). The mirror's remaining two databases
 * are RDS admin DBs (`postgres`, `rdsadmin`) and are never targets.
 */
export const MIRROR_DATABASES: readonly MirrorDbDef[] = [
  { mirror: 'scheduling_api', local: 'scheduling', scrubbed: true, scrubProject: 'program-hub', inDefaultSet: true },
  { mirror: 'sessions_api', local: 'sessions', scrubbed: true, scrubProject: 'program-hub', inDefaultSet: true },
  { mirror: 'iam_db', local: 'iam_local', scrubbed: true, scrubProject: 'rostering', inDefaultSet: true },
  { mirror: 'programs_api', local: 'programs', scrubbed: true, scrubProject: 'program-hub', inDefaultSet: true },
  { mirror: 'authz_db', local: 'authz_local', scrubbed: true, scrubProject: 'rostering', inDefaultSet: true },
  {
    mirror: 'openfga',
    local: 'openfga',
    scrubbed: false,
    scrubProject: 'rostering',
    inDefaultSet: false,
    note: "opt-in: local openfga's schema is owned by the openfga_migrate sidecar and has ZERO tables here; a whole-database restore makes it prod-dump-managed instead.",
  },
  { mirror: 'coach_api', local: 'coach_api', scrubbed: true, scrubProject: 'coach', inDefaultSet: true },
  {
    mirror: 'transcription_db',
    local: 'transcripts_local',
    scrubbed: true,
    scrubProject: 'student-data-system',
    inDefaultSet: false,
    note: 'opt-in: the ONE mapping not mechanically verified (transcription vs transcripts), and transcripts_local is playback-only (`--with playback`), absent from a default slot.',
  },
  { mirror: 'authz_sync', local: 'authz_sync_local', scrubbed: true, scrubProject: 'rostering', inDefaultSet: true },
  { mirror: 'iam_pii_db', local: 'iam_pii_local', scrubbed: true, scrubProject: 'rostering', inDefaultSet: true },
  { mirror: 'sis_db', local: 'sis_db', scrubbed: true, scrubProject: 'rostering', inDefaultSet: true },
  { mirror: 'ads_adm', local: 'ads_adm_local', scrubbed: true, scrubProject: 'student-data-system', inDefaultSet: true },
  { mirror: 'ledger_api', local: 'ledger_local', scrubbed: true, scrubProject: 'student-data-system', inDefaultSet: true },
  { mirror: 'content_api', local: 'content', scrubbed: true, scrubProject: 'program-hub', inDefaultSet: true },
  {
    mirror: 'chat',
    local: 'chat_local',
    scrubbed: true,
    scrubProject: 'student-data-system',
    inDefaultSet: false,
    note: 'opt-in: chat_local is playback-only (`--with playback`) and absent from a default slot.',
  },
];

/**
 * Local databases with NO mirror counterpart — reported explicitly by hydrate so
 * "why is my Connect data still synthetic?" is answered in the output rather
 * than by a reader guessing that a silent omission was a bug.
 */
export const NO_MIRROR_SOURCE: readonly { local: DbId; why: string }[] = [
  { local: 'insights_local', why: 'no insights_* database exists in the mirror.' },
  {
    local: 'surveys_api_local',
    why: 'the Student Surveys sector (student-data-system#495) is pre-release — no surveys_* database exists in the mirror yet.',
  },
  {
    local: 'connectv3',
    why: 'mongo (soa-connect-mongo-1) — the mirror is Postgres-only, so Connect data can never be hydrated from it.',
  },
];

/**
 * The confirmed `_real` tables per scrubbed database, as measured 2026-11-09.
 *
 * Two uses, neither of which decides what gets copied: the preview's table
 * counts, and the executing run's refusal when a table on this list stands on
 * the mirror as an ordinary table (it was scrubbed and now is not, so its rows
 * are raw). The set actually materialised is ENUMERATED from `pg_class` on the
 * live mirror, because hardcoding it would silently skip a newly-scrubbed table.
 */
export const CONFIRMED_REAL_TABLES: Readonly<Record<string, readonly string[]>> = {
  ads_adm: ['adm_attendance', 'adm_tracking_mode', 'snapshot_metadata'],
  authz_db: ['authz_decision_log', 'iam_group_projection'],
  authz_sync: ['iam_group_binding'],
  chat: ['chat_message', 'outbox_event', 'outbox_event_archive'],
  coach_api: ['content_instance', 'content_release', 'content_release_poll', 'module_answer'],
  content_api: ['outbox_event'],
  iam_db: [
    'api_key',
    'audit_logs',
    'auth_associations',
    'derived_evaluation_queue',
    'derived_evaluation_queue_dead',
    'event_outbox',
    'group_attributes',
    'group_auth_config',
    'groups',
    'login_profiles',
    'outbox_event',
    'outbox_event_archive',
    'snapshot_metadata',
    'user_external_identifiers',
    'user_policies',
    'user_profiles',
    'users',
  ],
  iam_pii_db: ['user_pii'],
  ledger_api: [
    'assessment_response',
    'assessment_submission',
    'ingestion_batch',
    'outbox_event',
    'roster_export_run',
    'section_dim',
    'staged_ingestion_row',
    'star_result_detail',
    'student_correlation',
    'student_identity_ref',
    'tutor_dim',
  ],
  programs_api: [
    'iam_group_binding',
    'outbox_event',
    'pod_assignment_override',
    'Program',
    'ProgramFile',
    'ProgramLink',
    'snapshot_metadata',
    'Subsection',
  ],
  scheduling_api: ['outbox_event', 'SlotOccurrenceCancellation', 'snapshot_metadata'],
  sessions_api: [
    'occurrence_cancellation_ref',
    'outbox_event',
    'pod_assignment_override_projection',
    'qtf_evaluation',
    'scheduling_holiday_ref',
    'session_observation_note',
    'slot_occurrence_cancellation_ref',
    'tutoring_session',
  ],
  sis_db: ['district_sync_config', 'sync_records'],
  transcription_db: ['segment_embeddings', 'transcription_jobs', 'transcripts', 'transcript_segments'],
};

/** Look up by mirror database name. */
export function findByMirrorName(name: string): MirrorDbDef | undefined {
  return MIRROR_DATABASES.find((d) => d.mirror === name);
}

/** Look up by local manifest database id. */
export function findByLocalId(id: string): MirrorDbDef | undefined {
  return MIRROR_DATABASES.find((d) => d.local === id);
}

/** The default `--db` selection (everything with a verified mapping and a slot-provisioned home). */
export function defaultSelection(): MirrorDbDef[] {
  return MIRROR_DATABASES.filter((d) => d.inDefaultSet);
}

/**
 * Resolve a `--db` token list to mirror-db defs, PRESERVING `MIRROR_DATABASES`
 * order (largest first) rather than the order the user typed — the report reads
 * the same however it was invoked. Accepts either name of a pair (`iam_db` or
 * `iam_local`) plus the pseudo-tokens `default` and `all`. Throws with the full
 * vocabulary on an unknown token: a typo must never silently hydrate less than
 * the caller asked for.
 */
export function resolveSelection(tokens: readonly string[]): MirrorDbDef[] {
  if (tokens.length === 0) return defaultSelection();
  const picked = new Set<MirrorDbDef>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === '') continue;
    if (token === 'default') {
      for (const d of defaultSelection()) picked.add(d);
      continue;
    }
    if (token === 'all') {
      for (const d of MIRROR_DATABASES) picked.add(d);
      continue;
    }
    const found = findByMirrorName(token) ?? findByLocalId(token);
    if (found === undefined) {
      throw new Error(
        `unknown --db '${token}'. Expected a mirror or local database name (or 'default' / 'all'): ` +
          MIRROR_DATABASES.map((d) => `${d.mirror}|${d.local}`).join(', '),
      );
    }
    picked.add(found);
  }
  return MIRROR_DATABASES.filter((d) => picked.has(d));
}

/** The local database NAME + OWNER ROLE for a mapping, read from the manifest. */
export function localTarget(def: MirrorDbDef, m?: Manifest): { name: string; ownerRole: string; ownerPw: string } {
  const db = getDb(def.local, m);
  return { name: db.name, ownerRole: db.ownerRole, ownerPw: db.ownerPw };
}
