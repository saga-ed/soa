# @saga-ed/soa-auth-token-client

Browser-side companion to [`@saga-ed/soa-auth-token`](../../node/auth-token/). Detects Janus 401s, builds the right login URL (honoring the `x-saga-preview-login` switchboard cookie), and navigates. Pure browser code — no framework, just functions.

## Surface

```ts
import { wrapFetchForJanus, redirectToLogin, isAllowedNext } from '@saga-ed/soa-auth-token-client';
```

- `wrapFetchForJanus(fetch, opts?)` — returns a `fetch` that intercepts 401 responses with `WWW-Authenticate: Janus …` and navigates to the login page (using the embedded login URL, with the current page URL as `next` when the server didn't pre-fill one).
- `redirectToLogin({ next, reasons })` — manual trigger.
- `buildLoginUrl(input, opts?)` — pure-function URL builder. Used by both helpers; exposed for callers that need full control.
- `isAllowedNext(url, allowlist?)` — the same `*.wootdev.com` suffix-match the gate uses, so frontends can fail fast on bad redirect targets.
- `readPreviewLoginVariant(cookieHeader?)` — reads the `x-saga-preview-login` cookie value (null when absent or unsafe).

## Why a separate package vs. living inside the login frontend

Every Saga frontend that calls a Janus-gated backend needs the same 401 interceptor. Putting it in one app traps it; putting it in `~/dev/soa` makes it a dep that any frontend can pull in.

## Sister package

[`@saga-ed/soa-auth-token`](../../node/auth-token/) — the Node-side mint, verify, and Express middleware. The two packages share constants by convention (cookie name, reason codes); they are not bidirectional dependencies.
