# SOA (saga-soa) — Pre-Launch Security & Access Review

**Scope:** Read-only security review of the launch-critical, fleet-wide `@saga-ed/soa-*` packages
consumed by every downstream Saga repo (janus, rostering, coach, student-data-system, qboard,
program-hub). Focus per the brief: api-util (dev-perimeter guard + preview headers), api-core
(auth/session/error/CORS), preview-headers, saga-fga / saga-authz-model, config, aws-util,
postgres, logger.

**Summary.** The carried-in XREPO-1 check — the dev-perimeter prod-off boot guard in
`api-util` — is **verified sound**: the guard refuses to boot with the perimeter ON in
production, the toggle forks correctly (default-ON dev/preview, OFF only on literal `"false"`),
and every failure direction is fail-closed (misconfig → crash or over-gate, never silent
under-protection). One genuinely exploitable, fleet-wide issue was found: `ExpressServer`'s
**default CORS reflects any origin with `credentials: true`** when `corsAllowedDomains` is
unset — the classic credentialed-CORS credential-theft misconfiguration, and it bypasses the
safe origin-allowlist primitive that `api-util` already ships. The remaining findings are
medium/low: FGA enforcement is fail-open by master-switch default, the FGA check API accepts
unvalidated ref strings, preview headers are forwarded without value validation, and Postgres
TLS defaults off.

## Severity counts

| Severity | Count |
|----------|-------|
| S1 (critical) | 0 |
| S2 (high)     | 1 |
| S3 (medium)   | 2 |
| S4 (low)      | 2 |
| Verified-sound (SEC-1) | 1 |

---

## [SEC-1] Dev-perimeter prod-off boot guard — VERIFIED SOUND (XREPO-1 verdict)
**Severity:** informational · **Confidence:** H

**Location:** `packages/node/api-util/src/utils/dev-perimeter-production.ts:40-75`,
`packages/node/api-util/src/utils/dev-perimeter-config.ts:35-96`

**Claim:** The invariant janus delegates here — "dev perimeter must be OFF in production, and a
misconfig must never silently run perimeter-ON in prod" — is correctly and safely enforced.

**Evidence (all four XREPO-1 sub-checks):**

(a) *Boot guard refuses perimeter-ON in prod.* `devPerimeterProductionViolation` returns a
non-null message exactly when `config.enabled && isProdEnv(nodeEnv)`, and
`assertDevPerimeterProductionConfig` throws on non-null (`dev-perimeter-production.ts:52-60,
69-75`):
```ts
if (config.enabled && isProdEnv(nodeEnv)) { return `DEV_PERIMETER_ENABLED must be false in production ...`; }
```
Tested at `dev-perimeter-production.test.ts:23-27,58-62`.

(b) *Toggle forks correctly.* Schema default is `enabled: z.boolean().default(true)`
(`dev-perimeter-config.ts:38`) → default-ON for dev/preview. The loader disables **only** on the
literal string `"false"`: `input.enabled = newVal !== 'false'` (`:83`). Verified default-ON when
unset and OFF on `"false"` (`dev-perimeter-config.test.ts:21-31`). The deprecated
`JANUS_REQUIRED` alias is honored only when the new name is unset, warns once, and the new name
wins when both are set (`:80-91`; tests `:72-91`).

(c) *"Production" detection.* `isProdEnv` is strict equality `nodeEnv === 'production'`
(`:40-42`). This signal is a deploy-time env var, **not attacker-controllable at runtime**, so
there is no remote spoof vector. The two misconfiguration directions both fail closed:
  - Real-prod with `NODE_ENV` mis-set (e.g. unset / `"Production"` / `"prod"`) → guard sees
    non-prod → perimeter stays ON (default) → end-user prod host gets JumpCloud-gated = **visible
    login outage, over-gating**, never silent exposure. This is the documented intended direction
    (`dev-perimeter-production.ts:22-25`).
  - Dev host masquerading as `NODE_ENV=production` → to boot at all it must ALSO set
    `DEV_PERIMETER_ENABLED=false` (else the guard throws). That is two deliberate
    deploy-config mistakes, not a runtime attack.

(d) *Unset/empty/malformed fails safe.* Parse layer: only literal `"false"` disables; `""`,
`"flase"`, `"False"`, `"0"` all leave the perimeter ON (`dev-perimeter-config.test.ts:33-38`).
Combined with the boot guard, a prod deploy that simply forgets to set the var defaults to
perimeter-ON, which the guard then converts into a hard boot failure — never a silent
perimeter-ON serving prod traffic, and never a silent perimeter-OFF where recon protection was
wanted. Both dangerous directions are closed.

**Impact:** None — posture is correct and defense-in-depth is layered (parse-layer fail-safe +
boot-guard) with independent coverage.

**Residual note (not a defect):** Enforcement depends on each *consuming* service actually
wiring `assertDevPerimeterProductionConfig` / folding `devPerimeterProductionViolation` into its
boot asserter; api-util cannot force the call. A consumer that omits it and ships default config
to prod would run perimeter-ON (fail-closed outage), not perimeter-OFF — so the omission is
self-announcing, not a silent hole. Worth a one-line CI/boot assertion in each downstream, but
not a soa defect.

**Suggested action:** None required. Optionally add a lint/boot check downstream that the guard
is invoked.

---

## [SEC-2] ExpressServer default CORS reflects any origin with credentials — fleet-wide
**Severity:** S2 · **Confidence:** H (behavior) / M (per-service exploitability)

**Location:** `packages/node/api-core/src/express-server.ts:45-77`

**Claim:** When a service does not set `corsAllowedDomains`, the shared server enables the
credential-theft CORS misconfiguration: reflect-any-origin + `credentials: true`.

**Evidence:**
```ts
credentials: true,                       // :48 — "always true — Saga apps use cross-origin cookie auth"
...
const domains = this.config.corsAllowedDomains ?? [];
if (domains.length > 0) { corsOptions.origin = (origin, cb) => { /* subdomain allowlist */ }; }
else { corsOptions.origin = true; }      // :76 — reflect ANY origin
```
With the `cors` package, `origin: true` reflects the caller's `Origin` back into
`Access-Control-Allow-Origin`, and `credentials: true` sets
`Access-Control-Allow-Credentials: true`. That is precisely the combination browsers treat as
"any site may make credentialed cross-origin requests and read the responses." The safe,
environment-isolated primitive already exists next door in api-util
(`buildSagaOriginAllowlist` / `originAllowed`, `api-util/src/utils/cors.ts:66-94`, anchored
`^https://…\.saga\.org$` / `\.wootdev\.com$` regexes, prod/dev isolation, no localhost in prod) —
but ExpressServer does not use it and its no-config default is the insecure path.

**Impact:** Any service booted through `ExpressServer` without `corsAllowedDomains` (the
documented backward-compat default) lets an attacker-controlled website issue authenticated
requests using the victim's ambient session cookie and **read the responses** cross-origin —
data exfiltration and, for state-changing endpoints, CSRF-with-readback. Because this is shared
infra, every downstream service that omits the field inherits the hole.

**Suggested action:** Make the safe path the default — have ExpressServer default its origin
policy to `buildSagaOriginAllowlist()` (NODE_ENV-isolated) instead of `origin: true`; treat an
empty/missing allowlist as fail-closed (reject cross-origin) rather than reflect-any. At minimum,
never pair `origin: true` with `credentials: true`.

---

## [SEC-3] FGA enforcement is fail-open by master-switch default
**Severity:** S3 · **Confidence:** H

**Location:** `packages/core/saga-fga/src/index.ts:31,82-92`

**Claim:** `enforceFgaRelation` is a silent no-op whenever `AUTHZ_FGA_ENFORCE !== 'true'`, so a
call site that relies on it for authorization is default-**allow** until the flag is explicitly
flipped on.

**Evidence:**
```ts
enforce: env.AUTHZ_FGA_ENFORCE === 'true',      // :31 — default false
...
export async function enforceFgaRelation(gate, ...): Promise<void> {
  if (!gate.enforce) return;                     // :89 — no check, no throw
  const allowed = await gate.check(...);
  if (!allowed) throw makeForbidden();
}
```
The design is intentional (docstring `:12-14`: adoption is non-breaking, "existing service-level
checks remain authoritative until the flag is flipped on"), and the `check` itself is correctly
default-deny (`res.allowed === true`, `:68`). The risk is purely the enforce master switch
defaulting off.

**Impact:** A downstream that mistakes tier-2 FGA for its authoritative gate — or a config drift
that leaves `AUTHZ_FGA_ENFORCE` unset in an environment expected to enforce — silently authorizes
every request. No error, no log; the gate just passes.

**Suggested action:** Keep the non-breaking default, but emit a one-time WARN when a gate is
constructed with `enforce=false`, and document prominently that `enforceFgaRelation` must never
be a service's sole authorization check while the flag is off. Consider an env-gated assertion in
prod-like environments that `AUTHZ_FGA_ENFORCE` is set intentionally.

---

## [SEC-4] FGA check/enforce API accepts unvalidated ref strings (ref-injection)
**Severity:** S3 · **Confidence:** M

**Location:** `packages/core/saga-fga/src/index.ts:66-71,82-92` vs
`packages/core/saga-authz-model/src/tuple-keys.ts:26-52`

**Claim:** `gate.check(user, relation, object)` and `enforceFgaRelation(...)` pass raw strings
straight to OpenFGA, but the package's own docstring examples build those strings by
interpolation (`` `user:${userId}` ``, `` `session:${id}` ``) — bypassing the `ensureValidId`
regex (`^[a-zA-Z0-9_-]+$`) that `userRef`/`objectRef`/`usersetRef` enforce.

**Evidence:** `tuple-keys.ts:26-31` validates ids to exclude `:` and `#`, precisely the
characters that separate type/id/relation in an FGA ref. But the check API takes pre-formed
strings and the docstrings (`saga-fga/src/index.ts:83-84`) demonstrate raw interpolation:
```ts
await enforceFgaRelation(ctx.fga, `user:${userId}`, 'host', `session:${id}`, ...);
```
If `userId` is attacker-influenced and contains e.g. `alice#member` or `*`, the resulting
userset (`user:alice#member`) changes the semantics of the authorization query.

**Impact:** Where a caller follows the documented interpolation pattern with any
externally-influenced id, a crafted id can alter which tuple/userset is evaluated —
authorization-decision manipulation. Exploitability depends entirely on caller hygiene, hence M.

**Suggested action:** Have `check`/`enforceFgaRelation` accept the typed `UserRef`/`ObjectRef`
brands (or validate with `ensureValidId` on the id portion internally), and change the docstring
examples to use `userRef(userId)` / `objectRef('session', id)` rather than raw interpolation.

---

## [SEC-5] Preview headers forwarded without value validation or environment guard
**Severity:** S4 · **Confidence:** M

**Location:** `packages/node/preview-headers/src/store.ts:30-54`,
`header-keys.ts:44-55`, `originate-map.ts:21-31`

**Claim:** Any inbound `x-saga-preview-*` header is captured and forwarded onto downstream S2S
calls unconditionally — no validation that the value matches the expected `sandbox-<name>` slug,
and no environment gate disabling capture in production.

**Evidence:** `extractPreviewHeaders` copies every `x-saga-preview-*` string header verbatim
(`header-keys.ts:48-53`); `getPreviewHeaders` merges them for outbound use (`store.ts:52-54`).
The value is never checked against a routing-slug pattern, and capture runs regardless of
`NODE_ENV`. The routing decision is ultimately the ALB's, which is why real-world impact is
bounded (this is the HTTP-plane half of a mechanism the rostering#774 incident already exposed —
there the failure was headless callers falling *through* to shared-main, addressed by
`PREVIEW_ORIGINATE_MAP`).

**Impact:** The library places full trust in caller-supplied routing headers. In an environment
whose ALB has sandbox/preview rules, an external caller who can reach a capturing service could
attempt to steer that service's downstream hops to a different preview/sandbox target. Primarily
a defense-in-depth gap; the load-bearing control is ALB rule scoping, not this code.

**Suggested action:** Validate captured/originated values against `^sandbox-[a-z0-9-]+$` (and
`pr-\d+`) and drop non-conforming ones; consider a no-op capture path when `NODE_ENV=production`
so prod services never forward preview routing at all.

---

## [SEC-6] Postgres provider defaults TLS off
**Severity:** S4 · **Confidence:** M

**Location:** `packages/node/postgres/src/postgres-provider-config.ts:45`

**Claim:** `ssl` defaults to `false`, so a consumer that forgets to set it connects to Postgres
without TLS.

**Evidence:** `ssl: z.union([z.boolean(), PostgresSslSchema]).default(false)` (`:45`). The
comment notes managed RDS / RDS Proxy require it be set, but the default is unencrypted.

**Impact:** A service deployed against a managed DB but missing the `ssl` override transmits
credentials and row data in cleartext on the DB path. Mitigated in practice by RDS Proxy often
rejecting non-TLS, and dev containers being local — hence low.

**Suggested action:** Default `ssl` to `true` (or to CA-pinned) and require an explicit opt-out
for local plaintext dev containers, so the secure posture is the default.

---

## Non-findings / verified clean

- **Postgres `SET` interpolation** (`postgres-provider.ts:155-168`): the interpolated
  `statementTimeoutMs` / `lockTimeoutMs` / `idleInTransactionSessionTimeoutMs` are
  `z.number().int()`-validated config values, not user input — **no SQL injection**.
- **Logger PII/secret redaction** (`logger/src/pino-logger.ts:30-65`): password/token/
  accessToken/refreshToken/clientSecret/otp/authCode plus `input`/`payload`/`body` wholesale are
  redacted with a shared config across both pino construction paths. Documented limits
  (message-string interpolation not redacted; shallow wildcards) are called out honestly.
- **aws-util `SecretHelper`** (`aws-util/src/secret-helper.ts`): logs secret *names* and AWS
  error objects on failure, never secret *values*. (Minor: `logger.error('Full error:', error)`
  passes the error as a positional arg, which may sidestep the logger's `err.*` redact paths —
  low, AWS errors are not secrets.)
- **api-util `buildSagaOriginAllowlist`** (`cors.ts:38-94`): anchored https-only regexes prevent
  suffix attacks (`wootdev.com.attacker.org`), prod/dev origin isolation, localhost excluded in
  prod, missing-origin rejected. This is the correct primitive — see SEC-2 for the gap that
  ExpressServer doesn't use it.

## Areas reviewed
- api-util: dev-perimeter guard + config (SEC-1, full), cors util, error-util.
- api-core: express-server (CORS/bootstrap — SEC-2). No auth/session middleware lives here (the
  perimeter middleware is in `@saga-ed/janus-client`, a separate repo).
- preview-headers: store, forward, originate-map, header-keys (SEC-5).
- saga-fga (SEC-3, SEC-4) + saga-authz-model tuple-keys/types (ref validation).
- config: DotenvConfigManager, MockConfigManager, ConfigValidationError (no secret defaulting/
  logging; MockConfigManager is test-only).
- aws-util secret-helper; logger pino redaction; postgres provider + config (SEC-6).

## Areas NOT reviewed (out of scope / lower attack surface)
- Event stack (event-outbox / event-consumer / event-envelope / observability / rabbitmq),
  pubsub-* family, redis-core, db (Mongo/MySQL) internals, mailer, health/inspect,
  fixture-serve, test-util, saga-stack-cli / mesh-fixture-cli, tgql-codegen, trpc-base,
  contract-check, web/ UI packages, and `apps/` example services. The GQL/TGQL/tRPC server
  bootstrap paths in api-core were only spot-checked (no auth logic resides in them).
- Dependency/supply-chain (lockfile, transitive CVEs) — not in scope for this pass.

---

*Reviewer: automated security pass · 2026-07-12 · read-only, no source modified.*
