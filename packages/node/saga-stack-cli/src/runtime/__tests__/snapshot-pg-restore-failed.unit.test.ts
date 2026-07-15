/**
 * `pgRestoreFailed` — the pure pg_restore exit classifier (runtime/snapshot.ts).
 *
 * The regression this pins: pg_restore prefixes client-side failures as
 * `pg_restore: error: …` (with the server's `ERROR:` embedded MID-line), and
 * the original bare-`ERROR:`-only detector never matched that shape — a
 * schema-drifted restore printed 7 errors, half-applied, and still reported
 * success. The stderr fixtures below are verbatim shapes from that incident
 * (a Cohort FK, unknown to the dump, blocked the TutoringPeriod --clean drop chain).
 */
import { describe, expect, it } from 'vitest';
import { pgRestoreFailed } from '../snapshot.js';

/** Verbatim shape of the incident stderr (pg_restore-prefixed errors only). */
const DRIFTED_RESTORE_STDERR = [
  'pg_restore: error: could not execute query: ERROR:  cannot drop constraint TutoringPeriod_pkey on table public."TutoringPeriod" because other objects depend on it',
  'DETAIL:  constraint Cohort_periodId_fkey on table public."Cohort" depends on index public."TutoringPeriod_pkey"',
  'HINT:  Use DROP ... CASCADE to drop the dependent objects too.',
  'Command was: ALTER TABLE IF EXISTS ONLY public."TutoringPeriod" DROP CONSTRAINT IF EXISTS "TutoringPeriod_pkey";',
  'pg_restore: error: COPY failed for table "TutoringPeriod": ERROR:  duplicate key value violates unique constraint "TutoringPeriod_pkey"',
  'pg_restore: warning: errors ignored on restore: 7',
].join('\n');

/** Benign --if-exists noise: objects missing on a fresh DB ⇒ non-zero exit, no error. */
const BENIGN_IF_EXISTS_STDERR = [
  'pg_restore: warning: errors ignored on restore: 0',
  'pg_restore: table "TutoringPeriod" does not exist, skipping',
].join('\n');

describe('pgRestoreFailed', () => {
  it('FAILS on pg_restore-prefixed errors (the swallowed-incident shape)', () => {
    expect(pgRestoreFailed(1, DRIFTED_RESTORE_STDERR)).toBe(true);
  });

  it('FAILS on bare server ERROR:/FATAL: lines (the shape the old regex caught)', () => {
    expect(pgRestoreFailed(1, 'ERROR:  relation "TutoringPeriod" already exists')).toBe(true);
    expect(pgRestoreFailed(1, '  FATAL:  terminating connection')).toBe(true);
  });

  it('tolerates a non-zero exit with only benign warnings (--if-exists skips)', () => {
    expect(pgRestoreFailed(1, BENIGN_IF_EXISTS_STDERR)).toBe(false);
  });

  it('never fails a clean exit, whatever stderr says', () => {
    expect(pgRestoreFailed(0, DRIFTED_RESTORE_STDERR)).toBe(false);
    expect(pgRestoreFailed(0, '')).toBe(false);
  });

  it('does not false-positive on an embedded mid-line ERROR: alone', () => {
    // DETAIL/context lines quote the server error mid-line; only a LINE-LEADING
    // marker (either shape) is a failure.
    expect(pgRestoreFailed(1, 'DETAIL: the previous ERROR: was quoted here')).toBe(false);
  });

  it('treats a null exit (killed) with error output as failure', () => {
    expect(pgRestoreFailed(null, DRIFTED_RESTORE_STDERR)).toBe(true);
  });
});
