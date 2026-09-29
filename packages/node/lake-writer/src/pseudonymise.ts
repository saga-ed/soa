// Pseudonymisation primitives for the SDS FERPA data lake.
//
// LOAD-BEARING INVARIANT (see infra/sds-secure-analytics/CLAUDE.md in the
// student-data-system repo, and the "compound-key invariant" restated in
// that repo's .claude/rules/sds-secure-analytics.md):
//
//   Saga `user_id` alone does NOT identify a person. Saga Connect's
//   Postgres database is dropped and reseeded at the start of every
//   school year, so the same numeric user_id refers to an UNRELATED
//   student in a different year. The canonical join key across the lake
//   is therefore the COMPOUND key {school_year, stable_external_id},
//   materialized as `student_year_hash`.
//
//   NEVER hash a bare user id / stable external id on its own and call
//   it a student identity. Always fold the school_year into the HMAC
//   input via `studentYearHash`.
//
// All hashes are HMAC-SHA256 over a shared salt held in AWS Secrets
// Manager (see salt.ts). The salt is never logged, hashed inputs are
// one-way, and the hash shape here MUST stay byte-for-byte identical to
// what the 17 fixtures CLIs in student-data-system already write —
// changing it would silently orphan every existing bridge in the lake.

import { createHmac } from 'node:crypto';

/**
 * Raw HMAC-SHA256 hex digest of `input` under `salt`. The single
 * primitive every other hash in this module is built from.
 */
export function hmacHex(salt: string, input: string): string {
  return createHmac('sha256', salt).update(input).digest('hex');
}

/**
 * The canonical per-(student, school_year) join key:
 *
 *   student_year_hash = HMAC_SHA256(salt, "{school_year}:{stableExternalId}")
 *
 * Deliberately carries NO namespace prefix — this is the one hash shape
 * every source system must agree on bit-for-bit so rows from different
 * sources join on `student_year_hash` for the same student-year. Do not
 * add a namespace, a version marker, or any other prefix here; see
 * `HASH_RECIPE_VERSION` below for why.
 *
 * `stableExternalId` must be a value that already carries (or implies) a
 * school-year scope from its own source system, e.g. Salesforce's
 * Participation.Id, a Renaissance "Student Identifier", or an
 * iam-api user id combined with the run's school_year. It is the
 * caller's job to pick a stable id that is actually unique per
 * (student, school_year) in its source.
 */
export function studentYearHash(
  salt: string,
  schoolYear: string,
  stableExternalId: string
): string {
  return hmacHex(salt, `${schoolYear}:${stableExternalId}`);
}

/**
 * A namespace-prefixed bridge hash: HMAC(salt, "{namespace}:{trimmed value}").
 * Returns null for null/undefined/empty-after-trim input so optional
 * source columns pass through as SQL NULL rather than hashing the empty
 * string into a collidable sentinel.
 */
export function namespacedHash(
  salt: string,
  namespace: HashNamespace | (string & {}),
  value: string | null | undefined
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return hmacHex(salt, `${namespace}:${trimmed}`);
}

/**
 * A namespace-prefixed hash over a COMPOSITE id, joined with `:` after
 * the namespace — e.g. `recordIdHash(salt, 'saga_program_membership', groupId, userId)`
 * produces `HMAC(salt, "saga_program_membership:{groupId}:{userId}")`.
 * Any part that is null, undefined, or empty-after-trim makes the whole
 * id un-computable, so the function returns null (the composite key is
 * incomplete).
 */
export function recordIdHash(
  salt: string,
  namespace: HashNamespace | (string & {}),
  ...parts: Array<string | null | undefined>
): string | null {
  const trimmedParts: string[] = [];
  for (const part of parts) {
    if (part == null) return null;
    const trimmed = part.trim();
    if (trimmed === '') return null;
    trimmedParts.push(trimmed);
  }
  return hmacHex(salt, `${namespace}:${trimmedParts.join(':')}`);
}

/**
 * HMAC(salt, "district_student_id:{id}") — the cross-source bridge
 * namespace shared by every dataset that carries a district/SIS student
 * id (Salesforce Contact.Student_ID__c, Renaissance's numeric Student
 * Identifier, Saga Connect's csv-sourced external_user_id, …). Every
 * source that populates this column MUST use this exact namespace or
 * the cross-source join silently breaks.
 */
export function districtStudentIdHash(salt: string, id: string | null | undefined): string | null {
  return namespacedHash(salt, HashNamespace.district_student_id, id);
}

/**
 * Heuristic: does `value` look like a numeric district/SIS student id
 * (as opposed to a UUID-shaped internal identifier)? Saga's observed
 * district ids range 5-9 digits; this accepts 4-12 digits — wide enough
 * to absorb every observed id, narrow enough to reject hyphenated/hex
 * UUIDs. Ported as-is from the Renaissance transform's
 * `looksLikeNumericDistrictId` — do not tighten or loosen the bound
 * without re-validating against the existing lake data's id shapes.
 */
export function looksLikeNumericDistrictId(value: string): boolean {
  return /^\d{4,12}$/.test(value.trim());
}

/**
 * Every namespace prefix in use (or reserved) across the lake. Namespaces
 * already live in Athena-queryable data under these exact strings — do
 * not rename an existing key. New source integrations should add their
 * namespace here first so it stays discoverable and collisions are
 * caught at review time. `namespace` parameters elsewhere in this
 * package accept `HashNamespace | (string & {})`, so an unlisted string
 * still compiles (a hard requirement to register every namespace before
 * writing code would be its own footgun) — but prefer registering it.
 */
export const HashNamespace = {
  // Salesforce
  district_student_id: 'district_student_id',
  sf_contact: 'sf_contact',
  sf_math_grades: 'sf_math_grades',
  sf_participation: 'sf_participation',
  sf_attendance: 'sf_attendance',
  sf_fsa: 'sf_fsa',
  sf_user: 'sf_user',
  // Renaissance
  renaissance_activity: 'renaissance_activity',
  renaissance_school: 'renaissance_school',
  // Saga Connect (app)
  saga_attendance: 'saga_attendance',
  saga_tutoring_period: 'saga_tutoring_period',
  saga_external_source: 'saga_external_source',
  saga_org: 'saga_org',
  saga_user: 'saga_user',
  saga_sls_session: 'saga_sls_session',
  saga_cu: 'saga_cu',
  saga_program_membership: 'saga_program_membership',
  saga_session_dosage: 'saga_session_dosage',
  saga_identity_xwalk: 'saga_identity_xwalk',
  saga_external_user: 'saga_external_user',
  app_user_label: 'app_user_label',
  // Transcripts
  sds_transcript: 'sds_transcript',
  sds_utterance: 'sds_utterance',
  // Reserved for upcoming external sources
  iam_user: 'iam_user',
  iam_group: 'iam_group',
  iam_membership: 'iam_membership',
  ph_program: 'ph_program',
  ph_period: 'ph_period',
  ph_pod: 'ph_pod',
  ph_session: 'ph_session',
  ph_occurrence: 'ph_occurrence',
  ph_participant: 'ph_participant',
  sis_org: 'sis_org',
  sis_enrollment: 'sis_enrollment',
  ledger_assessment: 'ledger_assessment',
} as const;

export type HashNamespace = (typeof HashNamespace)[keyof typeof HashNamespace];

/**
 * Documentation-only version marker for the hashing recipe implemented
 * in this module (HMAC-SHA256, the exact input shapes above). Bump it
 * only when you change the recipe in a way that's useful to record on
 * exported manifests for audit purposes (see export.ts). Do NOT fold
 * this into any hash input — existing lake data must keep hashing
 * identically; a version prefix in the HMAC input would silently orphan
 * every bridge already written.
 */
export const HASH_RECIPE_VERSION = 1;
