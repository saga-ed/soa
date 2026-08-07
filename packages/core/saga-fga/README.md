# @saga-ed/saga-fga

Tier-2 (per-resource) OpenFGA authorization gate for Saga services — a thin
`check` client over [`@openfga/sdk`](https://www.npmjs.com/package/@openfga/sdk)
plus an enforcement flag and a framework-agnostic helper.

Three query shapes, and the choice matters:

| Need                                 | Use                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Enforce on one object                | `check` / `enforceFgaRelation`                                                                      |
| Attribute _which_ rule allowed it    | `checkDetailed`                                                                                     |
| Return only the items a user may see | [`batchCheck`](#filtered-lists-batchcheck-not-listobjects)                                          |
| Debug _who_ holds a relation         | [`listUsersDiagnostic`](#the-reverse-question-listusersdiagnostic-debug-tier) — **debug tier only** |

Enumeration (`ListObjects`) is intentionally **absent** — see
[why](#filtered-lists-batchcheck-not-listobjects).

Pairs with [`@saga-ed/saga-authz-model`](../saga-authz-model) (the `.fga` model +
typed tuple-key builders) and the sync worker (which owns tuple **writes** —
ADR 0005). Services only **check**.

## Usage

```ts
import { createFgaGate, enforceFgaRelation } from '@saga-ed/saga-fga';

const fga = createFgaGate(); // from env: AUTHZ_FGA_ENFORCE, OPENFGA_API_URL, OPENFGA_STORE_ID, OPENFGA_MODEL_ID, OPENFGA_API_TOKEN

// In a resolver / handler:
await enforceFgaRelation(
  fga,
  `user:${userId}`,
  'host',
  `session:${sessionId}`,
  () => new TRPCError({ code: 'FORBIDDEN', message: 'Only the session host may do this' })
);
```

## Attribution: `checkDetailed`

Some gates must report not just _whether_ access was allowed but _which_ rule
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
  `session:${sessionId}`
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

## Filtered lists: `batchCheck` (not `ListObjects`)

When an endpoint must return only the items a user may see, **fetch the candidate
records from your own datastore, then ask about them**:

```ts
const districts = await db.districts.findMany({ where: { status: 'ACTIVE' } });
const verdicts = await fga.batchCheck(
  districts.map(d => ({
    user: `user:${actorId}`,
    relation: 'can_view',
    object: `staff_org:${d.id}`,
  }))
);
const visible = districts.filter(d =>
  verdicts.get(fgaBatchKey(`user:${actorId}`, 'can_view', `staff_org:${d.id}`))
);
```

Use `fgaBatchKey(user, relation, object)` for lookups — don't format the key by
hand. Requests are auto-chunked (50 per batch, 10 batches in parallel), so >50
items is allowed, but each chunk is a round trip: bound the candidate set rather
than passing an unbounded page.

**This package deliberately does not expose OpenFGA's `ListObjects`**, for two
measured reasons:

1. **It cannot report truncation.** `ListObjectsResponse` is `{ objects: string[] }`
   — no continuation token, no truncation flag. The operation is bounded
   server-side by a max-results cap and a deadline, so a **capped** list and a
   **complete** list are the same response. Silently under-reporting a list is an
   authorization _correctness_ bug (items the user may see never render, with no
   error), not a performance nit.
2. **Result count is not the cost driver.** Measured on rostering's prototype
   (`scripts/fga/prototype/latency.md`): p50 **28ms for ~421 objects** vs **73ms
   for one** — latency tracks graph-search shape, not result size. So "the set is
   small" is not a safety argument. And list-objects is **cache-immune**, while
   `check` goes ~23ms → ~1.4ms warm; every sub-check in a `batchCheck` is
   check-cache-eligible.

If a caller genuinely needs the id set _before_ touching its own datastore, that
belongs behind the PDP's own API with an explicit `truncated` contract — not
here, where the shape invites silent under-reporting.

> **A per-item failure is not a deny.** If any item comes back carrying an
> `error`, or the response omits a requested item, `batchCheck` throws
> `FgaUnavailableError` rather than reporting that item `false` — same contract as
> `check` (see below). A successfully returned map always holds exactly one entry
> per distinct question asked.

Pagination note: authorization filtering and pagination don't compose at the app
layer — filter-after-fetch yields nondeterministic page sizes and no reliable
total. If you need stable pagination, counts, or sort, the decision has to live
in your datastore (a projection join), not in a post-filter.

## The reverse question: `listUsersDiagnostic` (debug tier)

`(user, action)` and `(user, object)` are covered above; `listUsersDiagnostic`
completes the two-of-three triple — _"who holds `relation` on `object`?"_ —
for **debugging and audit tooling only**, and the name is the guardrail:

```ts
const who = await fga.listUsersDiagnostic('can_view', `qtf_review:${id}`, [
  'user', // direct subjects
  'group#member', // usersets of that shape
]);
// who.users         → ['user:ingrid']            direct subjects
// who.usersets      → ['group:demo-north#member'] references, NOT enumerations
// who.wildcardTypes → ['user']                    a public-wildcard tuple exists
```

OpenFGA's `ListUsers` has the same defect that keeps `ListObjects` out of this
package: the response carries **no truncation flag** while the server bounds
the search with a max-results cap and a deadline, so a capped listing and a
complete listing are indistinguishable. That disqualifies it from every
load-bearing job — never an enforcement input, never a notification/fan-out
source, never the audit of record (the PDP's decision log is that). It answers
"show me who the graph currently reaches" at a debugger's prompt, nothing else.

Reading the result honestly:

- **The listing contains only the subject shapes you asked for.** The
  `userTypes` entries map to server-side filters, which is why the parameter is
  required: a shape you don't name is _absent from the search_, not
  empty-because-nobody-holds-it. Forget `'group#member'` and every group grant
  reads as a missing tuple.
- A **userset** (`group:g#member`) is a reference — its members are not listed;
  a complete "who" requires expanding it separately.
- A **wildcard** entry means a `user:*` tuple holds **this** relation. On a
  marker relation (a `released` flip) that is the expected shape; it does _not_
  mean "everyone can" on any computed relation, where the model's intersections
  bind the wildcard.

A malformed argument — an object without its `type:` prefix, a filter that is
not `type` or `type#relation`, an empty filter list — throws `TypeError`: a
caller bug, detected locally, deliberately distinct from `FgaUnavailableError`
so it can never read as a PDP outage. Failures to reach a verdict throw
`FgaUnavailableError` like everything else here — a diagnostic that returned
`[]` during an outage would send the debugger chasing a phantom missing-tuple
bug.

## Contextual tuples

Ephemeral objects are never materialized as stored tuples. A session id decodes
to `(date, periodId, slotId, podId)`; the _durable_ facts (pod tutorship,
program scope edges) live in the graph, while the _derived_ facts — effective
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

| Var                 | Meaning                                        | Default                 |
| ------------------- | ---------------------------------------------- | ----------------------- |
| `AUTHZ_FGA_ENFORCE` | master switch (`"true"` to enable)             | off                     |
| `OPENFGA_API_URL`   | OpenFGA HTTP API                               | `http://localhost:8080` |
| `OPENFGA_STORE_ID`  | store id (required once enforcing)             | —                       |
| `OPENFGA_MODEL_ID`  | authorization model id                         | store's latest          |
| `OPENFGA_API_TOKEN` | preshared key, sent as `Authorization: Bearer` | — (no credentials)      |

> **The shared dev and prod OpenFGA servers run `authn=preshared`** — the
> `openfga-shared-<env>` task definition sets `OPENFGA_AUTHN_METHOD=preshared`.
> Against those, `OPENFGA_API_TOKEN` is **required**: without it every call is a
> 401, which the gate surfaces as `FgaUnavailableError`. That's the right
> failure _direction_ (never a silent deny), but the gate answers nothing. Leave
> it unset only for a local/CI OpenFGA started with no authn.

> 🪤 **Supply ONE key.** The server-side var is `OPENFGA_AUTHN_PRESHARED_KEYS`
> (_plural_ — OpenFGA accepts a comma-separated list). If `OPENFGA_API_TOKEN` is
> pointed at a secret holding `key1,key2` or a JSON blob, the client sends
> `Bearer key1,key2` and gets a 401 → `FgaUnavailableError` — a symptom
> **identical to having no token at all**, and easily misread as "the token
> wiring didn't land". Resolve to a single opaque key (use a `:jsonKey::`
> selector on the secret ARN if it holds JSON).

`FgaGateConfig` is secret-bearing once `apiToken` is set — never log or
`JSON.stringify` it; enumerate the non-secret fields instead.
