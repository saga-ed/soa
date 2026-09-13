import { describe, expect, it } from 'vitest';

import {
  isSchoolYear,
  parseSchoolYearLabel,
  schoolYearForRun,
  schoolYearFromDate,
} from '../school-year.js';

// Vectors ported from
// apps/node/fixtures/src/__tests__/transform-participation.test.ts in
// student-data-system.
describe('schoolYearFromDate', () => {
  it('returns SY25-26 for dates in [2025-08-01, 2026-08-01)', () => {
    expect(schoolYearFromDate(new Date('2025-08-01T00:00:00Z'))).toBe('SY25-26');
    expect(schoolYearFromDate(new Date('2025-09-05T16:00:00Z'))).toBe('SY25-26');
    expect(schoolYearFromDate(new Date('2026-05-26T12:00:00Z'))).toBe('SY25-26');
    expect(schoolYearFromDate(new Date('2026-07-31T23:59:59Z'))).toBe('SY25-26');
  });

  it('rolls to SY24-25 just before the Aug 1 2025 boundary', () => {
    expect(schoolYearFromDate(new Date('2025-07-31T23:59:59Z'))).toBe('SY24-25');
  });

  it('rolls to SY26-27 at the Aug 1 2026 boundary', () => {
    expect(schoolYearFromDate(new Date('2026-08-01T00:00:00Z'))).toBe('SY26-27');
  });

  it('returns null for null / unparseable / pre-2000 dates', () => {
    expect(schoolYearFromDate(null)).toBeNull();
    expect(schoolYearFromDate(new Date('not-a-date'))).toBeNull();
    expect(schoolYearFromDate(new Date('1999-09-01T00:00:00Z'))).toBeNull();
  });
});

describe('parseSchoolYearLabel', () => {
  it('parses "YYYY-YYYY"', () => {
    expect(parseSchoolYearLabel('2024-2025')).toBe('SY24-25');
  });

  it('parses "YYYY - YYYY" (extra whitespace around the dash)', () => {
    expect(parseSchoolYearLabel('2025 - 2026')).toBe('SY25-26');
  });

  it('passes an already-canonical SYxx-yy label straight through', () => {
    expect(parseSchoolYearLabel('SY24-25')).toBe('SY24-25');
  });

  it('rejects non-consecutive years', () => {
    expect(parseSchoolYearLabel('2024-2026')).toBeNull();
  });

  it('returns null for empty / undefined / unparseable input', () => {
    expect(parseSchoolYearLabel('')).toBeNull();
    expect(parseSchoolYearLabel(undefined)).toBeNull();
    expect(parseSchoolYearLabel(null)).toBeNull();
    expect(parseSchoolYearLabel('not a year')).toBeNull();
  });
});

describe('isSchoolYear', () => {
  it('matches the canonical SYxx-yy shape', () => {
    expect(isSchoolYear('SY25-26')).toBe(true);
    expect(isSchoolYear('SY99-00')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSchoolYear('2025-2026')).toBe(false);
    expect(isSchoolYear('sy25-26')).toBe(false);
    expect(isSchoolYear('SY25-2026')).toBe(false);
    expect(isSchoolYear('')).toBe(false);
  });
});

describe('schoolYearForRun', () => {
  it('derives the school year from the given run date via the Aug-1 boundary', () => {
    expect(schoolYearForRun(new Date('2025-09-05T16:00:00Z'))).toBe('SY25-26');
    expect(schoolYearForRun(new Date('2025-07-31T23:59:59Z'))).toBe('SY24-25');
  });

  it('throws when the run date cannot derive a school year', () => {
    expect(() => schoolYearForRun(new Date('1999-09-01T00:00:00Z'))).toThrow();
  });
});
