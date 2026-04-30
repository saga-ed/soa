# @saga-ed/soa-auth-token

Node-side mint, verify, and Express middleware for the Janus session token. See [`~/dev/janus`](../../../../janus/) for the system this serves and [`~/dev/janus/specs/contracts/drafts/janus-token.spec.md`](../../../../janus/specs/contracts/drafts/janus-token.spec.md) for the authoritative claim shape.

## Surface

```ts
import { createJanusAuth, mintJanusToken, setJanusCookieHeader } from '@saga-ed/soa-auth-token';
```

- `createJanusAuth(config?)` — factory returning `{ context(), require(opts?), current(), verifier }`. Mount `context()` globally; use `require({ permissions: ['admin'] })` per-route.
- `mintJanusToken(input, config)` — for the gate lambda only. Accepts an Ed25519 private key and a `kid`.
- `setJanusCookieHeader(token, opts?)` / `clearJanusCookieHeader(opts?)` / `readJanusCookie(cookieHeader)` — cookie helpers.
- `createVerifier(config)` — exposed for non-Express consumers.

## Defaults read from env

- `JANUS_JWKS_URL` (default `https://gate.wootdev.com/.well-known/jwks.json`)
- `JANUS_LOGIN_URL` (default `https://login.wootdev.com`)
- `JANUS_REQUIRED` — when set to `"false"`, `require()` no-ops and `context()` skips verification. Anything else (including unset) means required.

## Why not in `soa-api-core`?

`soa-api-core` is an Express server framework; this package is the auth primitive. Services that don't use `api-core` (e.g. raw Lambda handlers, Fastify) still need to verify Janus tokens, so the dependency direction is the other way: `api-core` consumers add this as a separate dep.

## Browser side

For the matching browser-side lib (401 interceptor, redirect URL builder, switchboard preview-cookie awareness), see [`@saga-ed/soa-auth-token-client`](../../web/auth-token-client/).
