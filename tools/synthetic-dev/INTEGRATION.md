# synthetic-dev × sandbox-compose — where they landed, and how they connect

> Discussion doc, 2026-06-11. Answers: "when we designed sandbox composition we pulled
> `saga-ed/soa:tools/synthetic-dev` into consideration — where did our final state land,
> and how can synthetic-dev leverage the sandbox machinery?"
>
> The `--compose-rest` / `--only` / `--sandbox` tooling this doc proposes lives alongside it
> in `tools/synthetic-dev/{up,refresh-suite}.sh` (saga-ed/soa#149). Code references to the
> console BFF (`orchestrator.ts`, `inspect-client.ts`, `drift.ts`, `registry.ts`, `api.ts`,
> `HANDOFF.md`) live in a different repo — `hipponot/microservices:services/console/` on the
> `feat/sandbox-visibility-console` branch (not yet on `main`).

## TL;DR — they never actually connected

The honest answer to "where did our final state land": **it didn't land on synthetic-dev at
all.** The two efforts ran in parallel and converged on exactly **one** shared primitive —
the deterministic `@saga-ed/*-seed-ids` catalog — but never met at the orchestration layer.

- synthetic-dev's docs (README / getting-started / up.sh / STATUS) contain **zero** references
  to sandbox, switchboard, preview-headers, console, or composition. The only overlap in the
  whole tree is two comments noting its seed is "the same data as preview/CI, stable ids across
  `--reset`" (`up.sh:646`, `:1170`).
- That's not an accident — it's the seam. Both systems seed from `@saga-ed/iam-seed-ids`
  (`personId('s-137')` → same UUID everywhere). synthetic-dev applies it via live `db:seed`;
  the canonical-seed sandbox applies it via S3 profile-snapshot restore of that same seed.
  **The data planes are already aligned by construction.** Nobody wired the control planes.

So this isn't "finish an integration we started." It's "two tools solved adjacent halves of the
same problem; here's how to compose them now that both exist."

## What each tool actually is

| | **synthetic-dev** (`soa:tools/synthetic-dev`) | **sandbox-compose** (this fleet) |
|---|---|---|
| Form | Bash-orchestrated **local** stack | Cloud **ephemeral** environments |
| Built | 2026-05-26 (`sds_92`), for saga-dash People/Schedule work + sis-api×dash cross-dev | 2026-06 (switchboard mesh + console + canonical seed, now mainlined) |
| Provisions | soa mesh (pg/redis/rabbitmq in Docker) + 7 native `pnpm dev` node procs | mesh + N services per-PR, deployed to ECS, routed by preview header |
| Pin my code | `local/integration` = `origin/main` + `--no-ff` my PRs, per repo | service **variant** = `main` / `pr-NN` / `dev-XX`, composed per service |
| Seed | live `db:seed` of `@saga-ed/*-seed-ids` (205 users) | S3 profile-snapshot restore of the **same** seed-ids (`canonical`) |
| Auth | `JANUS_REQUIRED=false`, devLogin, `many@saga.org` | `JANUS_REQUIRED=false` (API) or preview-cookie + SSO (real gate); same users |
| Inner loop | **HMR / live-edit** on the service you're hacking | none — a sandbox is a **deploy artifact, not a live-edit env** |
| Inspect | `--status` row counts + `verify.sh` (15 checks) | **console** BFF `/inspect` — manifest + status + drift, per service |

The crucial asymmetry is the last two rows. sandbox-compose gives you a real, prod-shaped,
zero-maintenance fleet — but you can't *edit code in it*. synthetic-dev gives you a live-edit
loop — but you pay for it with 5 repos checked out, 7 local processes, and a 10-item hand-
maintained drift log chasing upstream `main`.

## The decomposition: which synthetic-dev jobs can sandbox-compose absorb?

Don't think "replace." Decompose what synthetic-dev *does* and ask, job by job, who should own it:

| synthetic-dev job | sandbox-compose can do it? | notes |
|---|---|---|
| (a) provision the 6-API mesh + DBs + broker | ✅ natively | this is literally what `POST /compositions` is for |
| (b) deterministic, PII-free seed | ✅ already shared | same `@saga-ed/*-seed-ids`; cloud restores it from S3 |
| (c) pin my in-flight PRs across the fleet | ✅ **maps 1:1** | `local/integration` overlay ≡ "service on `pr-NN`, rest on `main`" |
| (d) fast inner loop on the code I'm editing | ❌ **cannot** | cloud sandbox is a deploy artifact; this is synthetic-dev's irreducible core |
| (e) drift-patch / repo-sync / port collisions / token churn | ✅ eliminated | pure local-only overhead; gone by construction in the cloud |

Row (c) is the cleanest conceptual bridge and worth stating plainly: **synthetic-dev's
`local/integration` branch — "`origin/main` plus my PRs, per repo" — is exactly a sandbox
composition where my service is pinned to its `pr-NN` variant and everything else rides
`main`.** The two tools independently invented the same "main + my changes" overlay; one builds
it from local git branches, the other from registered service variants.

Row (d) is why this is never a clean replacement. You cannot HMR a Vite dev server that lives in
ECS. Whatever you're *actively editing* has to run somewhere you can live-edit it.

## The recommendation: a hybrid, not a replacement

Three points on the ladder; the middle one is the target.

**1. Seed-only alignment (already true).** Keep both tools independent, just keep the seed-ids
catalog as the shared contract so a bug repro moves cleanly between local and cloud. This is
today's state and it's not nothing — it's why a synthetic-dev repro and a sandbox repro describe
the same `s-137`.

**2. Hybrid — run *only the service you're editing* locally; compose the rest as a sandbox.**
This is the win. Instead of synthetic-dev's "7 processes + 5 repos + drift log," you run **one**
local dev server (the service under edit, with HMR) and point it at a **cloud sandbox** holding
the rest of the fleet on `main` (or pinned variants), seeded `canonical`. Routing is the existing
preview-header primitive: your local service injects `x-saga-preview-<svc>: sandbox-<name>` on its
outbound calls and they land in the sandbox. Collapses synthetic-dev to its irreducible core (d)
and deletes jobs (a)(b)(c-for-everything-else)(e) entirely.

**3. Full-cloud.** No local stack at all — compose a sandbox, inspect via console, click through
saga-dash on `.wootdev.com`. Right for QA / review / demo / "does main work end-to-end," wrong for
the People-step edit loop synthetic-dev was built for.

## The three seams that decide whether the hybrid actually works

The hybrid's feasibility rests on local→cloud plumbing. Two of the three are already answered by
the codebase; one is the real open question.

**Seam 1 — auth across the boundary. ✅ Solved.** A local dash/service against a cloud sandbox
backend uses the same escape hatch synthetic-dev already uses: `JANUS_REQUIRED=false` on the
iam-api preview for API-driven flows (the perimeter is the employee gate, orthogonal to product
login). For the real gate, set `x-saga-preview-iam-api` cookies on `.wootdev.com` + employee SSO,
then log in as `many@saga.org` / `password123` — the *same canonical user that exists in
synthetic-dev's seed*, because same seed-ids. (Ref: canonical-seed memory, janus-perimeter gotcha.)

**Seam 2 — is saga-dash a composable sandbox service? ✅ Answered: it's the entrypoint, not a
deployable.** Per `fleet-mesh-handoff.md:44,:64`, **saga-dash is registered for header *routing*
but carries no `sandboxSupport`** — it's the browser entrypoint that *injects/forwards*
`x-saga-preview-*` via `@saga-ed/dash-runtime` `getPreviewHeaders()`
(`dash-data/.../trpc/clients.ts:86`). That's exactly what the hybrid needs: a **locally-running
dash can originate the headers** and route its tRPC calls into a sandbox backend. It does not
itself need to be deployed as a sandbox.

**Seam 3 — does preview-header routing support a *partially-local* mesh (one service local, rest
in sandbox)? ⚠️ Open — the load-bearing unknown.** The console handles the *reverse* gap well:
unpinned services route to `default` and it labels them honestly (`routedTo: 'default'`,
`orchestrator.ts:25`). But "request originates **outside** the sandbox (my laptop) and targets a
sandbox for some services while hitting `main`/local for others" is a direction the ALB rules
weren't explicitly designed for. Two sub-questions:
  - Can a **local** service emit `x-saga-preview-<svc>: sandbox-<name>` and have the cloud ALB
    honor it from an off-VPC origin? (Header routing is value-matching, so likely yes — but
    untested from a laptop origin, and CORS / cookie-domain on `.wootdev.com` may bite.)
  - When the locally-edited service needs a downstream that's *also* local, vs. one in the
    sandbox, who arbitrates per-call routing? synthetic-dev sidesteps this by having everything
    local; the hybrid has to split the mesh mid-call-graph.

Seam 3 is what a spike should prove before committing. The cheapest first probe: run **one**
service locally (say programs-api), compose the rest as a sandbox, and confirm a local
programs-api → sandbox iam-api call routes correctly with the preview header set. That's the
fleet-mesh-handoff's own "quick first win" (`saga-dash → programs-api → iam-api`) inverted to
start from a local origin.

### Seam 3 spike — static analysis result (2026-06-11)

Before standing up cloud resources, the routing path was traced statically. The "blocked"
picture from a first pass conflated browser-CORS with the actual S2S path; the real constraints
are narrower and clearer:

**What is NOT a barrier:**
- **CSRF / Origin allowlist — irrelevant on the S2S path.** S2S calls to iam-api use
  `X-Service-Token` (short-lived JWT from an OAuth `client_credentials` grant), routed to
  `serviceTokenProcedure`, which bypasses origin/CSRF entirely (`iam-api/.../service/service.router.ts:2`;
  the `enforceOriginOrCsrf` Bearer/token path in `iam-api/src/trpc.ts`). A locally-run service
  emits the *same* outbound headers as its cloud twin — same code — so origin checks don't fire.
- **ALB L7 routing — open.** The preview-header listener rules are pure host+header value
  matching with **no source-IP / path condition** for OIDC-off services like iam-api
  (`rostering/infra/iam-api/routing-template.yaml`, `EnableOidcAuth:'false'`). A laptop-origin
  request with the right header is honored at L7.
- **OIDC-on services & console `/inspect` — off the dev-loop path.** Those are separate surfaces
  (interactive login / inspection); the edit loop routes through iam-api (OIDC-off), not the
  console BFF. Not blockers for the hybrid.

**The two real seams that remain:**
1. **L4 security group (`AllowExternalTraffic`). ⚠️ Unverified.** The app ALB is internet-facing
   (`iac/.../app/app_lb_template.yaml:57 Scheme: internet-facing`) but its SG's 443 ingress is
   `Condition: ExternalFacing`, default `false` (`.../app_lb_sg_template.yaml:53,62-71`). If dev
   has it off, a laptop's TCP connection is dropped *before* any header matching. **Could not read
   the live dev value** — Observer tier has an explicit deny on `ssm:GetParameter
   /dev/app/allow-external-traffic`. Resolving this needs a one-tier elevation (or a direct
   `describe-security-groups` on the dev app-LB SG). This is the single tightest gate.
2. **Service-credential provisioning. ⚠️ The deeper seam.** Because S2S uses `X-Service-Token`,
   the local service must *mint a real token* — resolve `IAM_SERVICE_CREDENTIALS_SECRETNAME` from
   Secrets Manager and run the OAuth `client_credentials` exchange against the sandbox's iam-api
   (`sis-api/src/clients/iam.client.ts:50-71`). **synthetic-dev never had to do this**: iam's
   all-local dev-bypass *synthesizes* a service actor when auth is off, so no token mint, no
   secret access. A real cloud sandbox has auth on, so the laptop needs genuine S2S credentials
   (secret read + token endpoint reachable). This — not CSRF, not even L4 — is the thing the
   hybrid has to solve that the local flow elided.

**Revised verdict:** laptop→sandbox S2S routing is **plausible, gated by two things**: (1) the dev
SG flag (a dev-only config flip / known value, not a design dead-end), and (2) provisioning real
S2S credentials to the laptop (a credentials-distribution problem, tractable but new). Neither is
"blocked by design." A live probe is worth running *after* the SG value is confirmed and a dev
service credential is in hand.

### Seam 3 spike — LIVE infra verification (2026-06-11, via `saga-infra-dev` / AppInfra read)

The two static unknowns above were checked against the **live dev account** (396913734878).
Result: **Seam 1 (the L4 gate) is CLEAR in dev — routing through the load balancer works.**

- **One internet-facing ALB in dev: `dev-account-alb`** (`dev-account-alb-1771584553.us-west-2.elb.amazonaws.com`),
  SG `sg-0c4cafbdc6b5f9444`. The `AllowExternalTraffic`-conditional concern does **not** apply
  to live dev: the SG's **443 ingress is `0.0.0.0/0`** (and 80 is too). A laptop can open a TCP
  connection to this LB on 443 from anywhere. (The `/dev/app/allow-external-traffic` SSM param
  doesn't exist under that name in dev — the template default is moot; the deployed SG is open.)
- **The 443 listener has 116 rules, including live preview-header routing rules** keyed purely on
  `http-header` + `host-header`, **no source-IP condition, action = plain `forward`**, for exactly
  the services the hybrid would target:
  - `x-saga-preview-iam-api` → `iam.wootdev.com` / `rostering-api.wootdev.com` (priorities 1, 3,
    13, 16, 127, 190, 214, 228 — *all* clean forwards)
  - `x-saga-preview-sis-api` → `sis.wootdev.com` (priorities 328–388 — all clean forwards)
  - `X-Preview-{identity,catalog,admissions,analytics}-svc` → `soa-events-*.wootdev.com` (clean forwards)
- **Source-IP / OIDC gating exists on exactly ONE service — `transcripts-api`** (pri 21 = source-IP
  VPN-bypass variant, pri 22 = `authenticate-oidc`+forward), and even it retains ungated `forward`
  variants (pri 20, 23). **None of the iam-api / sis-api / soa-events preview rules carry source-IP
  or OIDC** — they forward unconditionally on host+header match. So the earlier "OIDC blocks it"
  worry was a transcripts-api artifact, not a property of the dev-loop path.

**Net:** routing a laptop request through the dev LB into a sandbox is **empirically supported
at the network + ALB layer today** — your instinct was right. The L4 gate is open, the L7
preview rules are live and ungated for iam-api/sis-api. The **only** remaining seam is
credential provisioning (Seam 2): the laptop service must mint a real `X-Service-Token` (resolve
`IAM_SERVICE_CREDENTIALS_SECRETNAME` + OAuth `client_credentials` against the sandbox iam-api) —
the one thing synthetic-dev's local auth-off dev-bypass synthesizes for free and a real sandbox
does not. That's a credentials-distribution task, not an infra blocker.

**Remaining to run the full live probe:** a dev iam-api service credential (Secrets Manager
`dev/<svc>/auth/iam-service-credentials`) reachable from the laptop, plus a live sandbox to
target. With those, the probe is: laptop service → `https://iam.wootdev.com` with
`x-saga-preview-iam-api: sandbox-<name>` + a minted `X-Service-Token` → expect the sandbox TG.

### Seam 2 — credential provisioning, traced end-to-end + live-verified (2026-06-11)

The full provisioning chain for a dev iam-api S2S credential, and its **live** state in dev:

**Mechanism (no IaC — operator-provisioned).** Service identities are NOT in a DB or a
CloudFormation `AWS::SecretsManager::Secret`. They live in Secrets Manager under
`iam-service-clients/<clientId>`; iam-api's `ServiceClientRegistry` reads that on demand at token
mint (`iam-api/src/services/service-client-registry.service.ts`, 300s cache). The pair:
- **Registry secret** `iam-service-clients/<id>` — `{clientId, clientSecretHash (argon2id),
  enabled, allowedAudiences}`. iam-api verifies the presented secret against this hash
  (`oauth-token.handler.ts` → `verifyClientCredentials`).
- **Consumer secret** (e.g. `rostering/dev/iam-serviceclient{id,secret}`) — the plaintext
  `client_id`/`client_secret` the *caller* holds, injected into its ECS task as
  `IAM_SERVICECLIENTID` / `IAM_SERVICECLIENTSECRET` env vars
  (`infra/sis-api/service-template.yaml`).

**Flow:** operator runs `pnpm --filter @saga-ed/iam-db provision:service-client <id>` → prints a
one-time plaintext secret + the argon2id hash → operator `create-secret`s the registry entry →
delivers plaintext out-of-band → consumer stores it in *their* secret + wires the task-def →
consumer's `ServiceTokenProvider` does OAuth `client_credentials` against `/v1/oauth/token` →
gets a 15-min `X-Service-Token` JWT → attaches it to S2S calls. The iam-api task role already
reads `iam-service-clients/*` via a wildcard policy (`bootstrap-template.yaml`), so **no
per-service IAM change** is needed. KMS signing key is the one IaC-managed piece
(`ServiceCredentialsSigningKmsKey`, RSA_2048, per-env bootstrap).

**Live dev state — the secret descriptions are STALE; SVCCRED already rolled out:**
- **sis-api's credential pair already exists in dev** (live Secrets Manager): registry secret
  `iam-service-clients/sis-api` (created 2026-06-08, "#228") + consumer
  `rostering/dev/iam-serviceclient{id,secret}` (created 2026-06-01). Their *descriptions* say
  "dormant / placeholder, unused until `SVCCRED_ENABLED=true`" — but that prose is stale.
- **The deployed dev iam-api runs `SVCCRED_ENABLED=true` AND `AUTH_AUTHENABLED=true`** — verified
  on the live ECS task definitions for *both* `rostering-iam-api-main` (`:131`) and the running
  **`rostering-iam-api-sandbox-demo` (`:2`)** sandbox. So the S2S surface is **live in dev today**,
  not pending.
- **What that means for the auth branches** (`iam-api/src/middleware/auth.middleware.ts`): the
  tokenless dev-bypass that synthesizes an all-zeroes `actingService` fires **only when
  `authEnabled=false`** (line ~64, boot-guarded to local `NODE_ENV=development`). A *deployed*
  sandbox has `authEnabled=true`, so **there is no tokenless path** — a `serviceTokenProcedure`
  call with no valid `X-Service-Token` resolves `actingService=null` and **hard-rejects**. This is
  exactly the gap synthetic-dev never sees (its local iam runs `authEnabled=false`).

**Net for the hybrid:** Seam 2 is **live today, not a future requirement.** To call a sandbox's
iam-api from a laptop you need a *real* minted `X-Service-Token`. The good news: the credential
already exists in dev (sis-api's pair), the consumer-side token-mint code already exists
(`ServiceTokenProvider`), and the laptop can reach `/v1/oauth/token` over the open LB (Seam 1). So
the probe is concrete: laptop loads sis-api's dev client_id/secret → mints a token against
`iam.wootdev.com` → calls a sandbox with `x-saga-preview-iam-api: sandbox-<name>` + that token.

**One detail to confirm before the probe:** the dev task defs show `SVCCRED_ENABLED=true` but
`SVCCRED_SIGNINGKEYARN=""`. The assertion forbidding that combo is **production-only**
(`assert-production-config.ts:148`), so dev tolerates an empty signing-key ARN — there's an
implicit dev signing path to confirm (default/derived key) so minted tokens actually verify.

## The fusion: a "compose-the-rest-as-a-sandbox" mode for synthetic-dev

With both seams characterized, here's the concrete shape of how the two tools fuse — and the
honest split between what runs **today** vs. what **rides in-flight work**.

### The conceptual mapping (already 1:1)

synthetic-dev's `refresh-suite.sh` already computes "which repos am I pinning" (the
`local/integration` overlay = `origin/main` + my PRs, per repo). The **complement set** — every
fleet service I'm *not* editing — is exactly what belongs in a cloud sandbox. So the fusion is:

```
refresh-suite.sh today:   pin {my repos} locally,           run ALL services locally
fusion mode:              run {the ONE repo I'm editing} locally,  compose {the rest} as a sandbox
```

The overlay file already names the pinned set; a `--compose-rest` flag would take the complement,
`POST /compositions` it (all on `main`, `canonical` seed), and emit the env the local service needs
(`IAM_API_URL=https://iam.wootdev.com` + the sandbox name for preview headers).

### Tier 1 — runnable TODAY (single-iam-api-dependency hybrid)

Every layer is verified for this exact shape, so a developer could run it this afternoon:

- **Routing** — proven on sandbox `rv` via per-request-nonce A/B in target logs (header present →
  sandbox TG; absent → main). [[project_switchboard_routing_validated]]
- **Seed** — `canonical` profile restore confirmed empirically on the same run.
- **L4/L7** — dev LB SG open `0.0.0.0/0`:443, iam-api preview rules ungated `forward` (verified live, this doc above).
- **Token mint** — dev iam-api signs S2S JWTs with a non-prod **ephemeral RSA keypair** when
  `SVCCRED_SIGNINGKEYARN` is empty (`service-jwt-issuer.service.ts` `ephemeralFallbackAllowed()`),
  and it verifies against its own JWKS — so a dev-minted token validates.
- **Credential** — sis-api's dev pair already exists; `SVCCRED_ENABLED=true` live.
- **The keypair-locality gotcha is already solved in code.** The ephemeral keypair is
  per-iam-api-task, so the token must be minted against the *same* sandbox task it'll be used on.
  `sis-api`'s `ServiceTokenProvider` **already spreads `getPreviewHeaders()` into the
  `/v1/oauth/token` mint call** (`iam.client.ts:24`, comment: "Preview headers route the mint to
  the same iam-api variant the token [targets]") and onto the S2S calls. A laptop reusing that
  client gets correct mint-and-call-against-one-sandbox routing for free.

**Tier-1 recipe:** compose a single iam-api sandbox (≤3-char name, e.g. `dev`) → run your
service locally pointing `IAM_API_URL=https://iam.wootdev.com`, with sis-api's dev client_id/secret
and `getPreviewHeaders()` returning `x-saga-preview-iam-api: sandbox-<name>` → mint + call both
route to the sandbox task → done. Good for: any backend service whose only live dependency is
iam-api (the sis-api×iam cross-dev case synthetic-dev was *also* built for).

### Tier 2 — the headline case, GATED on in-flight mesh work

synthetic-dev's *primary* use case (saga-dash People/Schedule step) needs iam-api **+ programs-api
+ scheduling-api + sessions-api** live — i.e. a **multi-service composition**. That is exactly what
is **not** runnable in dev as of the 2026-06-09 finding [[project_sandbox_composition_dev_broken]]:
non-iam-api services mis-wired to iam-api's hardcoded `sandbox-deploy.yml`, the iam-api TG name
overflowing 32 chars (forcing ≤3-char names), and sis-api lacking header propagation. Net then:
"only a single iam-api with a ≤3-char name provisions cleanly."

**Crucial framing:** those are **not new fusion blockers** — they are the existing
[[project_switchboard_mesh_test_plan]] workstream. The fusion is a *consumer* of that effort: when
the fleet mesh test passes, Tier 2 unlocks for free, no separate track. (And that area is
churning fast — `project_sandbox_callback_alb_blocked` landed a fix on 2026-06-11 — so the mesh
status should be re-checked live before relying on it, not read off the 06-09 memory.)

### The counterintuitive takeaway

The fusion works **today** for the *less common* case (a backend service editing against a live
iam-api) and **not yet** for the *headline* case (saga-dash editing against a live backend mesh) —
because the headline case needs multi-service compose, which is the thing currently blocked. So a
v0 fusion is real and shippable now for backend cross-dev; the dash-centric version ships when the
mesh-test workstream clears its three structural bugs.

## Implementation sketch: `refresh-suite.sh --compose-rest`

Grounded in the real structure of `refresh-suite.sh` (254 ln) and `up.sh` (721 ln), and the real
sandbox-api contract. Line numbers are within each script as of this analysis.

### Self-serve composition: blocked for interactive-less OIDC, but a sanctioned headless bypass exists (verified live)

The first design question is "can the script call `POST /compositions` itself?" **No — not today.**
The sandbox-api perimeter blocks it, verified live on the dev ALB (`dev-account-alb`, 443 listener,
rules 810–813 for `host=sandbox-api.wootdev.com`):

| pri | condition | action |
|-----|-----------|--------|
| 810 | `x-playwright-waf-bypass: <secret>` | forward |
| 811 | source-IP allowlist | forward |
| 812 | method `OPTIONS` (CORS preflight) | forward |
| 813 | (catch-all) | **`authenticate-oidc` + forward** |

A normal interactive-less request to `sandbox-api.wootdev.com` hits rule 813 and gets a **302 to
JumpCloud**. BUT — **rules 810, 811, and 813 all forward to the identical target group**
(`sandbox-api-dev-tg`, verified live). So the two non-OIDC rules reach the *exact same compositions
Lambda*, just skipping interactive auth:
- **810** — a static `x-playwright-waf-bypass: <secret>` header (the secret is plainly readable to
  anyone with infra-read; **not reproduced here**).
- **811** — a single source-IP `54.201.79.129/32` (a CI/NAT egress, not a dev VPN range).

Once past the ALB via either rule, `auth.py`'s **CI-bearer path** (`Authorization: Bearer` against
`sandbox-api/ci-api-key`) authorizes the actual operation. So a headless client that (a) presents a
bypass header to clear the perimeter and (b) carries the CI bearer to satisfy the app, **can
self-serve composition end-to-end today.** This corrects the earlier "categorically blocked" read:
the perimeter blocks *interactive-less OIDC*, but headless bypass to the same TG is a **sanctioned,
already-wired infra pattern** — rule 810 exists precisely so a non-browser automated client (the
e2e harness) can drive sandbox-api without a JumpCloud session. That is exactly `--compose-rest`'s
shape.

**The precise line, though: "the mechanism works" ≠ "the playwright secret is the CLI's auth path."**
Rule 810's header is semantically owned by the e2e/WAF concern — a static shared secret whose blast
radius is every laptop/shell-history/`.env` it lands in, and which a rotation for *playwright*
reasons would silently break the CLI (and vice versa). So:

- **As a POC, today:** the existing rule-810 bypass lets a dev run the full Tier-1 self-serve chain
  *right now* to prove the end-to-end path (compose → consume) without waiting on any new infra.
- **As the sanctioned path:** add a **sibling listener rule → same `sandbox-api-dev-tg`**, gated on
  either a dedicated `x-saga-compose-cli` secret or (cleaner, no secret to leak) a dev source-IP
  range extending the rule-811 pattern. That's a ~5-line listener-rule PR — the *same class* as the
  callback exemption in [[project_sandbox_callback_alb_blocked]]. **Bundle them.**

**Consequence — the v0 flow can be true self-serve** (not the weaker browser-composes→consume):

```
./up.sh --compose-rest --only <my-service>
  → script computes the complement, POSTs /api/v1/compositions (perimeter via bypass rule +
    CI bearer), polls until ready, then launches ONLY <my-service> locally pointed at it.
```

(The browser-composes→`--only`-consumes flow remains the zero-new-infra fallback if a dev has
neither bypass available.)

### What the script computes regardless: the complement set

Even in browser-composes mode, the overlay file already tells the script which services to put in
the sandbox — so it can *generate the exact compose request for the dev to paste/click*, and pick
the local service:

- `MANAGED_REPOS="rostering program-hub saga-dash"` (`refresh-suite.sh:56`) is the overlayable
  universe (soa + student-data-system are always-main, never overlaid).
- The pinned set is read from `integration-suite.local.tsv` into an assoc array — the canonical
  reader is `up.sh:148-155`'s `declare -A PINS` (key=repo, value=PR-csv). Mirror it.
- **Complement** = `MANAGED_REPOS` minus keys-of-`PINS`. But note the unit mismatch: the overlay
  is per-*repo*; the sandbox composes per-*service*. `rostering`→{iam-api, sis-api},
  `program-hub`→{programs-api, scheduling-api, sessions-api}, `saga-dash`→{saga-dash}. So the
  script needs a repo→services map (which doesn't exist yet — see "the registry gap" below) to
  turn "compose the rest" into a `services: {...}` map.

### The concrete seams (file:line)

**`refresh-suite.sh`:**
1. `:136` — init `COMPOSE_REST=0` (and `ONLY_SERVICE=""`).
2. `:142` — add `--compose-rest) COMPOSE_REST=1; shift ;;` next to `--reset`.
3. new mode block before the file-driven default at `:226` — build a `PINS`-style map from
   `$MANIFEST` (mirror `up.sh:148-155`), compute the complement over `MANAGED_REPOS:56`, expand
   repo→services, build the `{name, services, dbProfiles}` body, and **POST it** to
   `https://sandbox-api.wootdev.com/api/v1/compositions` with two headers: the perimeter bypass
   (rule-810 header for the POC; the sibling `x-saga-compose-cli` secret once the rule lands) **and**
   `Authorization: Bearer $(aws secretsmanager get-secret-value --secret-id sandbox-api/ci-api-key …)`.
   Then poll `GET /api/v1/compositions/<name>` until `overallStatus == ready` (enum:
   provisioning/ready/partial/tearing-down/failed). Print the follow-up `./up.sh --only
   <pinned-service> --sandbox <name>`. (Fallback if no bypass: emit the spec for the dev to compose
   in the UI, then the same `--only` consumer step.)

**`up.sh`:**
4. `:97-113` (URL constants) — add `SANDBOX_NAME=${SANDBOX_NAME:-}` and derive
   `SANDBOX_IAM_URL="https://iam.wootdev.com"` + the preview header value `sandbox-$SANDBOX_NAME`.
5. `:666-693` (verb/flag dispatch) — add `--only <svc>` and `--sandbox <name>` flag cases.
6. `:461-502` (`services_up`) — the real injection point. Today it's 7 **unconditional** `launch`
   calls. Gate them: when `--only` is set, launch just that one service, and for it **override the
   iam-targeting env** to the sandbox. The env knobs already exist per-service in the launch args:
   - programs/scheduling/sessions: `IAM_API_URL="$IAM_URL"` → `IAM_API_URL="$SANDBOX_IAM_URL"`
     (`:488,489,495`)
   - sis-api: `IAM_BASEURL`/`IAM_TOKENURL` → sandbox equivalents (`:486-487`)
   - **AND** get the preview header onto the local service's outbound iam calls. **This is the
     subtle part, and it is NOT an env swap** (verified against the real code). `getPreviewHeaders()`
     does **not** read an env var — it returns the `x-saga-preview-*` headers captured from the
     service's *current inbound request* via `AsyncLocalStorage` (`sis-api/src/middleware/preview-headers.ts`:
     `capturePreviewHeaders()` stores them at :23, `getPreviewHeaders()` reads the store at :54).
     The whole mechanism is **forward-propagation**: a service only emits
     `x-saga-preview-iam-api: sandbox-<name>` outbound if it *received* it inbound. There is no
     "make this service originate a preview header for itself" knob.

     So a locally-run programs-api/sis-api routes its iam calls to the **sandbox only when its own
     inbound request carried the header** — and the natural originator of that header is
     **saga-dash** (the browser entrypoint, confirmed earlier). Practical consequences for the
     `--only` launcher:
     - **If `--only` is a backend service driven via the local dash:** run the dash with
       `getPreviewHeaders()` originating `x-saga-preview-iam-api: sandbox-<name>` (dash uses
       `@saga-ed/dash-runtime`'s `getPreviewHeaders()`; for a *local* dash this is where the header
       must be seeded — via dash's own preview config, not the backend's env). Then it propagates
       through the local backend → sandbox iam automatically.
     - **If `--only` is driven by direct API calls (curl/test harness):** the caller must set
       `x-saga-preview-iam-api: sandbox-<name>` on each entry request; `capturePreviewHeaders()`
       then propagates it to the sandbox. A direct call **without** the header silently routes the
       backend's iam calls to **main** (empty variant `''`, `iam.client.ts:42`) — a quiet
       wrong-target footgun to guard against.

     *(Net correction to an earlier assumption: there is no `launch`-line env that injects the
     header. The header enters at the request boundary and forward-propagates. The `--only`
     launcher's job is to point `IAM_API_URL` at the sandbox host and ensure the driving entrypoint
     — dash or test harness — originates the header. This is the one spot the sketch had to be
     corrected against real code.)*

### The registry gap (the one real refactor)

Neither script has a service↔{repo,port,iam-env-keys} table — it's implicit in the 7 `launch`
lines (`up.sh:480-501`) and duplicated as colon-kv lists in `services_down:633`, `status:658`,
port-reap `:642`. `--compose-rest`/`--only` wants to *select* and *rewrite env for* one service,
which is awkward against 7 hardcoded calls. The clean enabling refactor: introduce
`declare -A SERVICE_REPO SERVICE_PORT SERVICE_IAMENV` once, drive `services_up`/`down`/`status`
from it, then `--only` is a one-line filter and the repo→services expansion (step 3) falls out of
`SERVICE_REPO` inverted. This refactor is optional for a hacky v0 (you can special-case the
`--only` service with an `if` in `services_up`) but it's the difference between a wedge and a clean
feature.

### Scope honesty for the sketch

- **Tier-1 (one backend service → single-iam-api sandbox)** is what this `--only`/`--sandbox` path
  delivers and is runnable today (all layers verified earlier in this doc).
- **Tier-2 (saga-dash → multi-service sandbox)** additionally needs multi-service compose to work
  in dev — still gated on [[project_switchboard_mesh_test_plan]]. The script changes above are the
  same for both; only the *target sandbox's* viability differs.
- **Self-serve compose** (`--compose-rest` actually POSTing) works **today via the existing
  rule-810 bypass** (POC) — all three sandbox-api ALB rules hit the same TG, so a headless client
  with a perimeter-bypass header + the CI bearer reaches the Lambda. The *sanctioned* path is a
  ~5-line sibling listener rule (dedicated secret or dev source-IP), bundled with the
  [[project_sandbox_callback_alb_blocked]] exemption. Without any bypass, `--compose-rest` degrades
  to a spec-generator and the dev composes in the UI.

## What I'd suggest discussing next

Both seams and the fusion shape are now characterized (above). Open decisions:

- **Run the Tier-1 live probe?** Everything for it is verified statically/live; the only thing
  left is to actually do it — laptop service + sis-api dev credential → mint + call a single
  iam-api sandbox → confirm the sandbox task logs the request. Low cost, high signal; it would
  turn "should work" into "proven" for the v0 fusion.
- **Build the `refresh-suite.sh --compose-rest` v0** for the backend-cross-dev case (Tier 1), or
  hold until the mesh-test workstream unlocks Tier 2 (the dash case) so the fusion ships covering
  the headline use case in one go?
- **Re-confirm mesh status live** before committing to a Tier-2 timeline — the
  [[project_sandbox_composition_dev_broken]] blockers are a 2026-06-09 read in a fast-moving area.
- **Ownership:** synthetic-dev lives in `saga-ed/soa`; sandbox-compose in this fleet. A fusion
  spans both repos — worth deciding who drives, and whether the compose-orchestration belongs in
  `refresh-suite.sh` (soa) or as a thin CLI in this fleet that soa shells out to.

---

*Investigation trail (all verified this session unless dated otherwise): both projects mapped;
seed-ids identified as the sole pre-existing overlap; Seam 1 (LB routing) confirmed live on the
dev ALB; Seam 2 (S2S credentials) traced end-to-end and found live (`SVCCRED_ENABLED=true`); dev
ephemeral signing path confirmed; the keypair-locality requirement found already solved in
`iam.client.ts`. Mesh-compose constraint cited from memory dated 2026-06-09 — re-verify before
relying on it.*
