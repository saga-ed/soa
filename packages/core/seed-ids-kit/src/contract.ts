/**
 * Framework-agnostic drift / value-lock checker for a `*-seed-ids` package.
 *
 * This is the harness that every domain's contract test reuses instead of
 * hand-rolling the same loops. It has NO test-framework dependency — it returns
 * a plain result so the caller asserts with whatever runner it uses:
 *
 *   import { checkSeedIdContract } from '@saga-ed/seed-ids-kit/contract';
 *   it('contract holds', () => {
 *     const r = checkSeedIdContract([
 *       { name: 'group', slugs: GROUP_SLUGS, id: groupId,
 *         derive: deriveGroupId, expect: PINNED_GROUP_IDS },
 *     ]);
 *     expect(r.failures).toEqual([]);
 *   });
 *
 * It checks, per collection: every slug resolves; (optional) the accessor equals
 * an independent re-derivation; (optional) the accessor equals pinned literals
 * (the value-lock that proves "adopting this changed no seeded id"); the id
 * matches the expected UUID shape; and ids are unique across all collections.
 */

/** UUID shape to enforce. `v5` = hash strategy; `any` = position-suffix etc. */
export type UuidShape = 'v5' | 'any' | 'none';

export interface SeedIdCollection {
  /** Label used in failure messages, e.g. `'group'` or `'program'`. */
  name: string;
  /** Every slug/key the package claims to resolve. */
  slugs: readonly string[];
  /** The package's public accessor under test. */
  id: (slug: string) => string;
  /** Optional independent re-derivation; `id(slug)` must equal `derive(slug)`. */
  derive?: (slug: string) => string;
  /** Optional pinned literals (value-lock); `id(slug)` must equal `expect[slug]`. */
  expect?: Readonly<Record<string, string>>;
  /** UUID shape to enforce on each id. Default `'v5'`. */
  uuid?: UuidShape;
}

export interface ContractResult {
  ok: boolean;
  /** One human-readable line per violation; empty when `ok`. */
  failures: string[];
  /** How many ids were evaluated. */
  checked: number;
}

const SHAPES: Record<Exclude<UuidShape, 'none'>, RegExp> = {
  v5: /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  any: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};

const sameKeySet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((k, i) => k === y[i]);
};

/** Run the contract checks across all collections. */
export function checkSeedIdContract(collections: readonly SeedIdCollection[]): ContractResult {
  const failures: string[] = [];
  const seen = new Map<string, string>(); // id -> "name:slug" (cross-collection uniqueness)
  let checked = 0;

  for (const c of collections) {
    const shapeKey = c.uuid ?? 'v5';
    const shape = shapeKey === 'none' ? null : SHAPES[shapeKey];

    // No stale literals: if pinned, the slug set must equal the pinned key set.
    if (c.expect && !sameKeySet(c.slugs, Object.keys(c.expect))) {
      failures.push(`[${c.name}] slug set != expect keys (stale literal or missing slug — re-pin)`);
    }

    for (const slug of c.slugs) {
      checked++;
      let id: string;
      try {
        id = c.id(slug);
      } catch (err) {
        failures.push(`[${c.name}] id("${slug}") threw: ${(err as Error).message}`);
        continue;
      }
      if (!id) {
        failures.push(`[${c.name}] id("${slug}") returned empty`);
        continue;
      }
      if (c.derive) {
        const derived = c.derive(slug);
        if (derived !== id) {
          failures.push(`[${c.name}] drift: id("${slug}")=${id} != derive=${derived}`);
        }
      }
      if (c.expect) {
        const pinned = c.expect[slug];
        if (pinned && pinned !== id) {
          failures.push(`[${c.name}] value-lock: id("${slug}")=${id} != pinned ${pinned}`);
        }
      }
      if (shape && !shape.test(id)) {
        failures.push(`[${c.name}] id("${slug}")=${id} fails ${shapeKey} UUID shape`);
      }
      const dup = seen.get(id);
      if (dup) {
        failures.push(`[${c.name}] collision: id("${slug}")=${id} also produced by ${dup}`);
      } else {
        seen.set(id, `${c.name}:${slug}`);
      }
    }
  }

  return { ok: failures.length === 0, failures, checked };
}
