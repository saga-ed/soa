/**
 * Deterministic manifest canonicalization (soa#353): a no-op build must produce
 * a no-op diff. These cover the guarantees the build step relies on — deep key
 * sorting, array-order preservation, idempotency, and stable formatting.
 */

import { describe, expect, it } from 'vitest';
import { canonicalizeManifestJson, sortKeysDeep } from '../manifest-canonicalize.js';

describe('sortKeysDeep', () => {
  it('sorts object keys at every depth', () => {
    const input = { b: 1, a: { d: 2, c: 3 } };
    expect(Object.keys(sortKeysDeep(input) as object)).toEqual(['a', 'b']);
    const nested = (sortKeysDeep(input) as { a: object }).a;
    expect(Object.keys(nested)).toEqual(['c', 'd']);
  });

  it('preserves array order while sorting keys inside elements', () => {
    const input = { list: [{ z: 1, a: 2 }, { y: 3, b: 4 }] };
    const out = sortKeysDeep(input) as { list: Array<Record<string, number>> };
    expect(out.list.map((o) => Object.keys(o))).toEqual([['a', 'z'], ['b', 'y']]);
    // element order unchanged
    expect(out.list[0].a).toBe(2);
    expect(out.list[1].b).toBe(4);
  });

  it('leaves primitives and null untouched', () => {
    expect(sortKeysDeep(null)).toBe(null);
    expect(sortKeysDeep(42)).toBe(42);
    expect(sortKeysDeep('x')).toBe('x');
  });
});

describe('canonicalizeManifestJson', () => {
  it('produces byte-identical output regardless of input key order', () => {
    const a = JSON.stringify({
      commands: { 'stack:up': { id: 'stack:up' }, 'e2e:run': { id: 'e2e:run' } },
      version: '1.0.0',
    });
    const b = JSON.stringify({
      version: '1.0.0',
      commands: { 'e2e:run': { id: 'e2e:run' }, 'stack:up': { id: 'stack:up' } },
    });
    expect(canonicalizeManifestJson(a)).toBe(canonicalizeManifestJson(b));
  });

  it('is idempotent', () => {
    const raw = JSON.stringify({ b: [3, 1, 2], a: { n: 1 } });
    const once = canonicalizeManifestJson(raw);
    expect(canonicalizeManifestJson(once)).toBe(once);
  });

  it('emits 2-space indentation and a trailing newline', () => {
    expect(canonicalizeManifestJson('{"b":1,"a":2}')).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });
});
