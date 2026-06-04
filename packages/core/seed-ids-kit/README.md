# @saga-ed/seed-ids-kit

The shared mechanism behind the `*-seed-ids` contract: canonical, deterministic
entity UUIDs that independent service seeds agree on **without a shared database**.

Each domain already owns a `*-seed-ids` package (`iam-seed-ids`,
`program-seed-ids`, `content-seed-ids`, …). They were hand-rolling the same
pieces — a derivation function, a drift test, sometimes a frozen `ids.ts` plus
codegen. This kit factors out the parts that are genuinely identical so a new
domain writes only its **catalog** and picks a **strategy**. It is **opt-in**:
add it as a dependency when convenient. It owns **no** catalog and **no** id
values — those stay in each domain's repo.

## Why a browser-safe hash matters

The original `iam-seed-ids` used `node:crypto`, which can't run in a browser, so
it had to pre-compute ("freeze") its ids into a committed `ids.ts` and ship a
separate node-only `derive` entry plus a codegen script. This kit's `uuidv5`
uses [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (audited,
zero-dependency, isomorphic) and is **byte-identical** to the `node:crypto`
output — so a package can compute ids on demand in any runtime and drop the
freeze/codegen entirely, with **zero id change**.

## API

```ts
import { uuidv5, makeHashDeriver, makePositionDeriver } from '@saga-ed/seed-ids-kit';
import { checkSeedIdContract } from '@saga-ed/seed-ids-kit/contract';
```

- **`uuidv5(name, namespace)`** — RFC 4122 v5 (SHA-1) UUID, browser-safe.
- **`makeHashDeriver(rootNamespace)`** — the **hash** strategy. `derive(key)` is
  order-independent; any service computes the same id from a stable key. Use for
  **new** domains. `rootNamespace` is the contract — never change it.
- **`makePositionDeriver(namespacePrefix, padWidth = 12)`** — the **position-suffix**
  strategy. `derive(n)` = `` `${namespacePrefix}${pad(n)}` ``. Pure formatting; use
  **only** to preserve an existing hand-assigned scheme so persisted data isn't
  orphaned.
- **`checkSeedIdContract(collections)`** — framework-agnostic drift / value-lock
  test helper. Returns `{ ok, failures, checked }`; assert `failures` is empty.

> The two strategies are **not** interchangeable and must not be unified — each
> encodes ids already persisted in a domain's database.

## Recipe — a new `*-seed-ids` domain (opt-in)

```ts
// catalog.ts — pure data, no ids
export const WIDGETS = [{ slug: 'alpha' }, { slug: 'beta' }] as const;
export const WIDGET_SLUGS = WIDGETS.map((w) => w.slug);

// index.ts — pick a strategy, compute on demand
import { makeHashDeriver } from '@saga-ed/seed-ids-kit';
const ROOT = '…fixed-namespace-uuid…';
const deriveWidgetId = makeHashDeriver(ROOT);
export const widgetId = (slug: string) => deriveWidgetId(`widget:${slug}`);

// index.test.ts — one call locks the contract
import { checkSeedIdContract } from '@saga-ed/seed-ids-kit/contract';
import { WIDGET_SLUGS } from './catalog.js';
import { widgetId } from './index.js';
it('contract holds', () => {
  const r = checkSeedIdContract([{ name: 'widget', slugs: WIDGET_SLUGS, id: widgetId }]);
  expect(r.failures).toEqual([]);
});
```

When migrating an **existing** package, pass `expect:` with the current ids as
pinned literals — `checkSeedIdContract` then proves the migration changed none of
them. The full narrative recipe lives in the saga-iac plugin's `seed-fixtures.md`.
