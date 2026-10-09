import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  districtStudentIdHash,
  hmacHex,
  looksLikeNumericDistrictId,
  namespacedHash,
  normalizeUsState,
  recordIdHash,
  stateStudentIdHash,
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

describe('normalizeUsState', () => {
  it('trims and uppercases valid USPS codes (states, DC, territories)', () => {
    expect(normalizeUsState(' md ')).toBe('MD');
    expect(normalizeUsState('dc')).toBe('DC');
    expect(normalizeUsState('Pr')).toBe('PR');
    expect(normalizeUsState('GU')).toBe('GU');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '  ', 'XX', 'MARYLAND', 'M', 'M D', 'ZZ', null, undefined]) {
      expect(normalizeUsState(bad)).toBeNull();
    }
  });
});

describe('stateStudentIdHash', () => {
  const GOLDEN_SALT = 'golden-test-salt';

  it('matches golden vectors computed independently', () => {
    expect(stateStudentIdHash(GOLDEN_SALT, 'md', ' 0012345 ')).toBe(
      '702833e19bfdfd9ef63d3517b75ebcf8d0d373d10632b75e0d848f49291e6cd0'
    );
    expect(stateStudentIdHash(GOLDEN_SALT, ' PR', 'A1b2C3')).toBe(
      'a9cfb87e0cc3dcfd43547afdcf36bb8c97f9f37e709ce3a96c642e8370291d03'
    );
    expect(stateStudentIdHash(GOLDEN_SALT, 'DC', '9876543210')).toBe(
      'dc30b0ae3483dd94c7d182e8e549bc6fdf4892f45dbd9aa68e81145acfec38f7'
    );
  });

  it('hashes "state_student_id:{ST}:{trimmed id}" through the shared HMAC path', () => {
    expect(stateStudentIdHash(SALT, 'MD', '0012345')).toBe(
      expectedHash('state_student_id:MD:0012345')
    );
    expect(stateStudentIdHash(SALT, 'MD', '0012345')).toBe(
      namespacedHash(SALT, 'state_student_id', 'MD:0012345')
    );
  });

  it('is case- and whitespace-insensitive on the state, whitespace-insensitive on the id', () => {
    const base = stateStudentIdHash(SALT, 'MD', '0012345');
    expect(stateStudentIdHash(SALT, ' md\t', '  0012345\n')).toBe(base);
  });

  it('does not normalize the id beyond trim (no zero-stripping, no case folding)', () => {
    expect(stateStudentIdHash(SALT, 'MD', '12345')).not.toBe(
      stateStudentIdHash(SALT, 'MD', '0012345')
    );
    expect(stateStudentIdHash(SALT, 'MD', 'ab1')).not.toBe(stateStudentIdHash(SALT, 'MD', 'AB1'));
  });

  it('differs by state and is not year-salted', () => {
    expect(stateStudentIdHash(SALT, 'MD', '1')).not.toBe(stateStudentIdHash(SALT, 'VA', '1'));
  });

  it('returns null for an invalid state', () => {
    expect(stateStudentIdHash(SALT, 'XX', '123')).toBeNull();
    expect(stateStudentIdHash(SALT, '', '123')).toBeNull();
    expect(stateStudentIdHash(SALT, null, '123')).toBeNull();
    expect(stateStudentIdHash(SALT, undefined, '123')).toBeNull();
  });

  it('returns null for an empty id', () => {
    expect(stateStudentIdHash(SALT, 'MD', '')).toBeNull();
    expect(stateStudentIdHash(SALT, 'MD', '   ')).toBeNull();
    expect(stateStudentIdHash(SALT, 'MD', null)).toBeNull();
    expect(stateStudentIdHash(SALT, 'MD', undefined)).toBeNull();
  });
});
