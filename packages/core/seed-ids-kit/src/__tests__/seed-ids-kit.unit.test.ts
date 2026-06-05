import { describe, it, expect } from 'vitest';
import { uuidv5, uuidv7, makeHashDeriver, makePositionDeriver, checkSeedIdContract } from '../index.js';

// The root namespace + known literals from rostering's iam-seed-ids, frozen on
// origin/main. These are the regression oracle: if the browser-safe uuidv5 here
// reproduces them byte-for-byte, then iam-seed-ids can adopt this kit with ZERO
// id change. (Verified independently against node:crypto.)
const IAM_ROOT = 'b2c4f1a0-5e3d-4c9a-8f6b-1d2e3f4a5b6c';
const IAM_KNOWN: Record<string, string> = {
  'group:seed': '71698462-2be8-5eb8-9d7c-443bd59d0c3f',
  'group:riverside': '0adcbddd-7406-545e-ba75-ef195181145a',
  'group:metro': '4cedce5b-9173-57c2-8f10-72f8ce4a0509',
  'group:lincoln': '92c6c9f4-c764-519f-9873-7df7b77f5410',
};

describe('uuidv5 (browser-safe v5)', () => {
  it('reproduces iam-seed-ids frozen literals byte-for-byte', () => {
    for (const [name, want] of Object.entries(IAM_KNOWN)) {
      expect(uuidv5(name, IAM_ROOT)).toBe(want);
    }
  });

  it('is deterministic and namespace-sensitive', () => {
    expect(uuidv5('group:lincoln', IAM_ROOT)).toBe(uuidv5('group:lincoln', IAM_ROOT));
    expect(uuidv5('group:lincoln', IAM_ROOT)).not.toBe(
      uuidv5('group:lincoln', 'a1b2c3d4-0001-4000-8000-000000000000'),
    );
  });

  it('emits a well-formed v5 UUID', () => {
    expect(uuidv5('x:y', IAM_ROOT)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('uuidv7 (time-ordered)', () => {
  it('emits a well-formed v7 UUID', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the 48-bit millisecond timestamp big-endian', () => {
    // 0x0123456789ab -> first 12 hex are the timestamp, then the version nibble
    expect(uuidv7(0x0123456789ab).startsWith('01234567-89ab-7')).toBe(true);
  });

  it('sorts lexicographically by time', () => {
    const ts = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_005_000, 1_700_001_000_000];
    const ids = ts.map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('is unique within the same millisecond (random low bits)', () => {
    const t = 1_700_000_000_000;
    expect(uuidv7(t)).not.toBe(uuidv7(t));
  });
});

describe('makeHashDeriver', () => {
  const derive = makeHashDeriver(IAM_ROOT);
  it('matches uuidv5 for the same key (order-independent)', () => {
    expect(derive('group:seed')).toBe(IAM_KNOWN['group:seed']);
    expect(derive('group:metro')).toBe(uuidv5('group:metro', IAM_ROOT));
  });
});

describe('makePositionDeriver', () => {
  it('reproduces the program-seed-ids a1b2c3d4-0001-* scheme', () => {
    const programId = makePositionDeriver('a1b2c3d4-0001-4000-8000-');
    expect(programId(1)).toBe('a1b2c3d4-0001-4000-8000-000000000001');
    expect(programId(9)).toBe('a1b2c3d4-0001-4000-8000-000000000009');
  });
  it('honors a custom pad width', () => {
    expect(makePositionDeriver('ns-', 4)(7)).toBe('ns-0007');
  });
});

describe('checkSeedIdContract', () => {
  const SLUGS = ['seed', 'riverside', 'metro', 'lincoln'] as const;
  // strip the `group:` prefix off IAM_KNOWN's keys -> slug-keyed pins
  const PINNED: Record<string, string> = Object.fromEntries(
    Object.entries(IAM_KNOWN).map(([k, v]) => [k.replace('group:', ''), v]),
  );
  const deriveGroup = (slug: string) => uuidv5(`group:${slug}`, IAM_ROOT);
  const groupId = (slug: string): string => PINNED[slug] ?? '';

  it('passes when accessor, derivation, and pins all agree', () => {
    const r = checkSeedIdContract([
      { name: 'group', slugs: SLUGS, id: groupId, derive: deriveGroup, expect: PINNED },
    ]);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(4);
  });

  it('detects derivation drift', () => {
    const r = checkSeedIdContract([
      { name: 'group', slugs: SLUGS, id: () => 'a1b2c3d4-0001-4000-8000-000000000001', derive: deriveGroup, uuid: 'any' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes('drift'))).toBe(true);
  });

  it('detects a value-lock break (an id changed)', () => {
    const wrong: Record<string, string> = { ...PINNED, lincoln: '00000000-0000-5000-8000-000000000000' };
    const r = checkSeedIdContract([
      { name: 'group', slugs: SLUGS, id: (s) => wrong[s] ?? '', expect: PINNED },
    ]);
    expect(r.failures.some((f) => f.includes('value-lock'))).toBe(true);
  });

  it('detects stale pinned keys not in the catalog', () => {
    const r = checkSeedIdContract([
      { name: 'group', slugs: ['seed'], id: groupId, expect: PINNED },
    ]);
    expect(r.failures.some((f) => f.includes('stale literal'))).toBe(true);
  });

  it('detects cross-collection id collisions', () => {
    const dup = '11111111-1111-4111-8111-111111111111';
    const r = checkSeedIdContract([
      { name: 'a', slugs: ['x'], id: () => dup, uuid: 'any' },
      { name: 'b', slugs: ['y'], id: () => dup, uuid: 'any' },
    ]);
    expect(r.failures.some((f) => f.includes('collision'))).toBe(true);
  });

  it('flags a wrong UUID shape', () => {
    const r = checkSeedIdContract([
      { name: 'group', slugs: ['seed'], id: () => 'not-a-uuid', uuid: 'v5' },
    ]);
    expect(r.failures.some((f) => f.includes('shape'))).toBe(true);
  });
});
