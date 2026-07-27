# @saga-ed/saga-fga

Tier-2 (per-resource) OpenFGA authorization gate for Saga services — a thin
`check` client over [`@openfga/sdk`](https://www.npmjs.com/package/@openfga/sdk)
plus an enforcement flag and a framework-agnostic helper.

Pairs with [`@saga-ed/saga-authz-model`](../saga-authz-model) (the `.fga` model +
typed tuple-key builders) and the sync worker (which owns tuple **writes** —
ADR 0005). Services only **check**.

## Usage

```ts
import { createFgaGate, enforceFgaRelation } from '@saga-ed/saga-fga';

const fga = createFgaGate(); // from env: AUTHZ_FGA_ENFORCE, OPENFGA_API_URL, OPENFGA_STORE_ID, OPENFGA_MODEL_ID

// In a resolver / handler:
await enforceFgaRelation(
  fga,
  `user:${userId}`,
  'host',
  `session:${sessionId}`,
  () => new TRPCError({ code: 'FORBIDDEN', message: 'Only the session host may do this' }),
);
```

## Attribution: `checkDetailed`

Some gates must report not just *whether* access was allowed but *which* rule
allowed it — program-hub's sessions gate derives its D19 actor (`HOST` vs
`ADMIN`) from exactly that.

An OpenFGA Check answers only `allowed`, so a union relation
(`can_edit: host or edit_grant`) cannot say which side fired. The model
therefore keeps the branches **separable** — an invariant recorded in the
`session` type of `scripts/fga/prototype/unified-graph.fga` (rostering) — and
`checkDetailed` asks each branch independently (in parallel) and reports the
winners. No `Expand` call is involved.

```ts
const d = await fga.checkDetailed(
  `user:${callerId}`,
  ['host', 'edit_grant'], // attribution-priority order
  `session:${sessionId}`,
);
// d.allowed → boolean
// d.via     → 'host' | 'edit_grant' | undefined  (first branch that held)
// d.branches→ every branch that held
```

`via` reports the **first** branch that held in the order supplied, so pass
them in priority order: `['host', 'edit_grant']` makes HOST win when a caller
is both.

> **Caller obligation — keep `relations[]` exhaustive.** The array you pass must
> be exactly the branches of the corresponding `can_*` union.
> `checkDetailed(u, ['host', 'edit_grant'], o)` is caller-side duplication of
> `can_edit: host or edit_grant`. If a branch is ever added to that union in the
> model, an enumerating caller **denies access the model would allow**. The
> drift fails closed (under-authorization, not a hole), and it is silent — so
> when you add a branch to a `can_*` union, grep for its `checkDetailed`
> callers. The capability catalog codegens these shapes, so branch growth is
> anticipated.

## Contextual tuples

Ephemeral objects are never materialized as stored tuples. A session id decodes
to `(date, periodId, slotId, podId)`; the *durable* facts (pod tutorship,
program scope edges) live in the graph, while the *derived* facts — effective
pod after SWAP/ABSENT at NOW, the per-occurrence override host after its
live-membership gate — are resolved by the caller and ride in on the request:

```ts
await fga.checkDetailed(`user:${callerId}`, ['host', 'edit_grant'], `session:${id}`, [
  { user: `pod:${effectivePodId}`, relation: 'pod', object: `session:${id}` },
  { user: `user:${overrideHostId}`, relation: 'host', object: `session:${id}` },
]);
```

Contextual-tuple relations are marked as such in the partition registry
(ADR 0006 §3) — they are **never also stored**.

## An unreachable verdict is not a denial

`check` returns a bare boolean, so a swallowed failure would be
indistinguishable from a legitimate `false` — an outage would silently present
as "permission denied". Instead, any failure to reach a verdict (transport
error, non-2xx, missing `OPENFGA_STORE_ID`) throws **`FgaUnavailableError`**.

Keep the two apart at the call site. Masking a confirmed deny as `NOT_FOUND` is
correct (D15); masking an outage that way is not — it surfaces as the distinct
authz-unavailable signal (north star P5):

```ts
try {
  await enforceFgaRelation(fga, user, 'host', object, () => notFound());
} catch (e) {
  if (e instanceof FgaUnavailableError) throw serviceUnavailable(); // NOT NOT_FOUND
  throw e;
}
```

## Enforcement is off by default

`AUTHZ_FGA_ENFORCE` must equal the exact string `true` to enable checks. While
off, `enforceFgaRelation` is a no-op (it never constructs a client or reaches
the network), so adopting the gate is non-breaking — existing service-level
checks stay authoritative until the flag flips on.

## Env

| Var | Meaning | Default |
|---|---|---|
| `AUTHZ_FGA_ENFORCE` | master switch (`"true"` to enable) | off |
| `OPENFGA_API_URL` | OpenFGA HTTP API | `http://localhost:8080` |
| `OPENFGA_STORE_ID` | store id (required once enforcing) | — |
| `OPENFGA_MODEL_ID` | authorization model id | store's latest |
