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
