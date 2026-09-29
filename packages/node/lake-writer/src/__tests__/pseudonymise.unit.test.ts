import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  districtStudentIdHash,
  hmacHex,
  looksLikeNumericDistrictId,
  namespacedHash,
  recordIdHash,
  studentYearHash,
} from '../pseudonymise.js';

const SALT = 'test-salt';

function expectedHash(input: string): string {
  return createHmac('sha256', SALT).update(input).digest('hex');
}

describe('hmacHex', () => {
  it('is a plain HMAC-SHA256 hex digest', () => {
    expect(hmacHex(SALT, 'hello')).toBe(expectedHash('hello'));
    expect(hmacHex(SALT, 'hello')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('studentYearHash', () => {
  it('hashes "{schoolYear}:{stableExternalId}" with NO namespace prefix', () => {
    const out = studentYearHash(SALT, 'SY25-26', 'abc');
    expect(out).toBe(expectedHash('SY25-26:abc'));
    expect(out).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is sensitive to school_year — the compound-key invariant', () => {
    const sy2526 = studentYearHash(SALT, 'SY25-26', 'same-id');
    const sy2627 = studentYearHash(SALT, 'SY26-27', 'same-id');
    // A bare user id must NOT hash the same across school years, or a
    // reseeded Postgres user_id would silently merge two different
    // students' records.
    expect(sy2526).not.toBe(sy2627);
  });
});

describe('namespacedHash', () => {
  it('hashes "{namespace}:{trimmed value}"', () => {
    expect(namespacedHash(SALT, 'district_student_id', ' 12345678 ')).toBe(
      expectedHash('district_student_id:12345678')
    );
  });

  it('returns null for null, undefined, and empty-after-trim values', () => {
    expect(namespacedHash(SALT, 'sf_user', null)).toBeNull();
    expect(namespacedHash(SALT, 'sf_user', undefined)).toBeNull();
    expect(namespacedHash(SALT, 'sf_user', '')).toBeNull();
    expect(namespacedHash(SALT, 'sf_user', '  ')).toBeNull();
  });
});

describe('districtStudentIdHash', () => {
  it('uses the district_student_id namespace and trims', () => {
    expect(districtStudentIdHash(SALT, ' 87654321 ')).toBe(
      expectedHash('district_student_id:87654321')
    );
  });

  it('is null for null/undefined/blank ids', () => {
    expect(districtStudentIdHash(SALT, null)).toBeNull();
    expect(districtStudentIdHash(SALT, undefined)).toBeNull();
    expect(districtStudentIdHash(SALT, '   ')).toBeNull();
  });
});

describe('looksLikeNumericDistrictId', () => {
  it('accepts 4-12 digit numeric strings', () => {
    expect(looksLikeNumericDistrictId('1234')).toBe(true);
    expect(looksLikeNumericDistrictId('123456789012')).toBe(true);
    expect(looksLikeNumericDistrictId('87654321')).toBe(true);
  });

  it('rejects UUID-shaped and out-of-range values', () => {
    expect(looksLikeNumericDistrictId('123')).toBe(false);
    expect(looksLikeNumericDistrictId('1234567890123')).toBe(false);
    expect(looksLikeNumericDistrictId('a1b2c3d4-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('recordIdHash', () => {
  it('hashes a composite id as "{namespace}:{part}:{part}..."', () => {
    const out = recordIdHash(SALT, 'saga_program_membership', 'group-1', 'user-1');
    expect(out).toBe(expectedHash('saga_program_membership:group-1:user-1'));
  });

  it('returns null when any part is null, undefined, or empty-after-trim', () => {
    expect(recordIdHash(SALT, 'saga_program_membership', 'group-1', null)).toBeNull();
    expect(recordIdHash(SALT, 'saga_program_membership', undefined, 'user-1')).toBeNull();
    expect(recordIdHash(SALT, 'saga_program_membership', 'group-1', '   ')).toBeNull();
  });
});
