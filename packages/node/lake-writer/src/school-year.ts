// School-year derivation for the SDS FERPA data lake. Every dataset
// landed in the lake is partitioned by `school_year` in the `SYxx-yy`
// format (e.g. `SY25-26`) — this module is the single place that format
// is produced and parsed, so every source system agrees on the exact
// same August-1 boundary.

const SCHOOL_YEAR_LABEL_RE = /^SY\d{2}-\d{2}$/;

/**
 * Derive the school-year code for a date. Boundary: August 1 (UTC).
 *
 *   2025-08-01 <= d < 2026-08-01  ->  "SY25-26"
 *   2024-08-01 <= d < 2025-08-01  ->  "SY24-25"
 *
 * Returns null for null / unparseable / pre-2000 dates. Exact port of
 * `schoolYearFromDate` from
 * apps/node/fixtures/src/sources/salesforce/transform-participation.ts
 * in student-data-system — the byte-for-byte behaviour is load-bearing
 * because the lake already holds data hashed against these exact
 * school_year strings; do not change the boundary or the format without
 * a full re-ingest plan.
 */
export function schoolYearFromDate(d: Date | null): string | null {
  if (d == null || Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-indexed; 7 = Aug
  if (year < 2000) return null;
  const startYY = month >= 7 ? year : year - 1;
  const endYY = startYY + 1;
  return `SY${String(startYY).slice(2)}-${String(endYY).slice(2)}`;
}

/**
 * Parse a human/upstream-formatted school-year label into the canonical
 * `SYxx-yy` form. Port of `parseStarSchoolYear` from
 * apps/node/fixtures/src/sources/renaissance/transform-star-math-assessment.ts,
 * extended to pass an already-canonical `SYxx-yy` value straight through.
 *
 * Accepts:
 *   "2024-2025"     -> "SY24-25"
 *   "2025 - 2026"   -> "SY25-26"  (extra whitespace around the dash)
 *   "SY24-25"       -> "SY24-25" (pass-through; see `isSchoolYear`)
 *
 * Returns null on no match, or when the two years aren't consecutive
 * (`end !== start + 1`).
 */
export function parseSchoolYearLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (isSchoolYear(trimmed)) return trimmed;

  const m = /^(\d{4})\s*-\s*(\d{4})$/.exec(trimmed);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end !== start + 1) return null; // sanity-check
  return `SY${String(start).slice(2)}-${String(end).slice(2)}`;
}

/** True when `s` matches the canonical `SYxx-yy` school-year label shape. */
export function isSchoolYear(s: string): boolean {
  return SCHOOL_YEAR_LABEL_RE.test(s);
}

/**
 * The snapshot-stamping rule used by dim/snapshot-grain datasets (e.g.
 * a full-table export with no per-row event date): derive the school
 * year from the run date itself via the same August-1 boundary as
 * `schoolYearFromDate`. Throws if the run date somehow fails to derive
 * a school year (pre-2000 clock, which should never happen in
 * production but would indicate a badly misconfigured caller).
 */
export function schoolYearForRun(runDate: Date = new Date()): string {
  const sy = schoolYearFromDate(runDate);
  if (sy == null) {
    throw new Error(
      `schoolYearForRun: could not derive a school_year from run date ${runDate.toISOString()}`
    );
  }
  return sy;
}
