import { describe, expect, it } from 'vitest';
import {
  buildIdentityMap,
  generateFakeIdentity,
  passwordHashForUserId,
} from '../identity-map.js';
import { FIRST_NAMES, LAST_NAMES } from '../fake-names.js';

describe('generateFakeIdentity', () => {
  it('is deterministic across invocations for the same user_id', () => {
    const a = generateFakeIdentity('1362');
    const b = generateFakeIdentity('1362');
    expect(a).toEqual(b);
  });

  it('produces different identities for different user_ids', () => {
    const a = generateFakeIdentity('1362');
    const b = generateFakeIdentity('1363');
    expect(a.first_name + a.last_name).not.toEqual(b.first_name + b.last_name);
  });

  it('emits the canonical email format', () => {
    const id = generateFakeIdentity('1362');
    expect(id.email).toBe('user_1362@fixture.test');
  });

  it('preserves the source user_id', () => {
    const id = generateFakeIdentity('1362');
    expect(id.user_id).toBe('1362');
    expect(id.mysql_user_id).toBe(1362);
  });

  it('returns null mysql_user_id for non-numeric ids', () => {
    const id = generateFakeIdentity('abc-123');
    expect(id.mysql_user_id).toBeNull();
  });

  it('picks names from the bundled pools', () => {
    const id = generateFakeIdentity('1');
    expect(FIRST_NAMES).toContain(id.first_name);
    expect(LAST_NAMES).toContain(id.last_name);
  });

  it('exposes a screen_name of "first last"', () => {
    const id = generateFakeIdentity('42');
    expect(id.screen_name).toBe(`${id.first_name} ${id.last_name}`);
  });
});

describe('buildIdentityMap', () => {
  it('keys identities by both string and parsed int', () => {
    const map = buildIdentityMap(['1362', '1363']);
    expect(map.by_user_id.size).toBe(2);
    expect(map.by_mysql_user_id.size).toBe(2);
    expect(map.by_user_id.get('1362')).toEqual(map.by_mysql_user_id.get(1362));
  });

  it('skips non-numeric user_ids in the int map', () => {
    const map = buildIdentityMap(['abc', '123']);
    expect(map.by_user_id.size).toBe(2);
    expect(map.by_mysql_user_id.size).toBe(1);
    expect(map.by_mysql_user_id.has(123)).toBe(true);
  });

  it('de-duplicates input', () => {
    const map = buildIdentityMap(['1', '1', '2']);
    expect(map.by_user_id.size).toBe(2);
  });

  it('produces byte-stable output regardless of input order', () => {
    const a = buildIdentityMap(['1', '2', '3']);
    const b = buildIdentityMap(['3', '1', '2']);
    expect([...a.by_user_id.entries()]).toEqual([...b.by_user_id.entries()]);
  });
});

describe('passwordHashForUserId', () => {
  it('matches generateFakeIdentity password_hash', () => {
    const id = generateFakeIdentity('1362');
    expect(passwordHashForUserId('1362')).toBe(id.password_hash);
  });

  it('accepts numeric input', () => {
    expect(passwordHashForUserId(1362)).toBe(passwordHashForUserId('1362'));
  });
});
