# Launch Ops & Scale Review — `soa` (saga-soa) shared infra

**Scope:** Read-only pre-launch review of the shared deploy/observability/config/tooling primitives that every downstream fleet repo builds on: `saga-stack-cli`, `observability`, `health`, `config`, `aws-util`, `logger`, plus the `api-util` dev-perimeter guard and workspace version consistency. No source/config/infra file was modified.

## Summary

The shared primitives are, on balance, in good shape for launch. The dev-perimeter production guard (`api-util`) is correctly fail-safe and the CLI cannot enable the perimeter in prod (it has no prod launch path and only ever writes the flag as `false`). The `health`/`readiness` primitives are strong (dependency probes, hard timeouts, 503 contract for ALB). The `observability` tracing/metrics wiring is thoughtful (PII sanitization, deployment-tag correlation, bounded metric cardinality). The launch planner is pure and fail-fast on missing tokens. The material launch/scale risks are concentrated in two shared libraries that every service depends on at boot: `aws-util` (a secrets-fetch path that **fails open to an empty config object** and no retry/region tuning) and `config` (env loader that accepts empty-string as a satisfied required value, and offers no coercion for boolean/number fields — a footgun the shipped `PinoLoggerSchema` itself trips). The `logger` prod path has a Fargate logging trap if `isExpressContext` is not set. None are S1; one S2.

| Severity | Count |
|----------|-------|
| S1 | 0 |
| S2 | 1 |
| S3 | 5 |
| S4 | 2 |

---

## Findings

### [OPS-1] `aws-util` secret fetch fails open to an empty config object — S2, Confidence H
- **Location:** `packages/node/aws-util/src/secret-helper.ts:58-83`
- **Claim:** A failed Secrets Manager fetch is swallowed and returns `undefined`; `get_secret_json`/`get_secret_yaml` then coalesce that to `'{}'` and return an **empty object cast to `T`** with no validation. A service resolving a secret (DB password, JWT signing key, S2S client secret) at boot can silently start with empty/default config instead of crashing.
- **Evidence:**
  ```ts
  } catch (err) {
    const error = ensureError(err);
    this.logger.error(`Failed to get secret ${secret_name}`, error);
    return undefined;                       // swallow → undefined
  }
  ...
  get_secret_json = async<T = any>(secret_name): Promise<T> => {
    const secret_data = await this.get_secret(secret_name);
    return JSON.parse(secret_data ?? '{}') as T;   // undefined → {} as T
  };
  ```
- **Impact:** Fail-open on a missing/inaccessible secret in production. Instead of a loud boot failure (the desired posture for a missing credential), downstream code receives `{}` and may proceed with `undefined` fields — e.g. an unset signing key or an empty allowlist — surfacing only later as auth/data faults that are hard to trace back to the secret miss. This directly undercuts the "fail fast on missing required prod config" property the review is meant to verify.
- **Suggested action:** Make `get_secret_json`/`get_secret_yaml` throw when the underlying secret is `undefined` (or add a `required` variant that throws). At minimum, do not coalesce `undefined` to `{}`; let the parse fail. Consider Zod-validating the parsed shape so an empty/partial secret is rejected at boot.

### [OPS-2] `config` loader treats empty-string env as a satisfied required value — S3, Confidence M
- **Location:** `packages/core/config/src/dotenv-config-manager.ts:26-36`
- **Claim:** The loader copies an env var into the validated input whenever it is `!== undefined`. An env var set to the empty string (`FOO_DATABASE_URL=`) is therefore passed through, and a plain `z.string()` field accepts `''` — so a required secret that is present-but-empty passes validation rather than failing fast.
- **Evidence:**
  ```ts
  if (env[envVar] !== undefined) {
    input[key] = env[envVar];   // '' is !== undefined → accepted
  }
  ```
- **Impact:** A misconfigured deploy that exports an empty required var (common with templated CFN/SSM references that resolve to nothing) boots successfully with an empty connection string / URL / secret instead of erroring. Fail-open on a class of prod misconfig.
- **Suggested action:** Treat empty-string as absent (`env[envVar] !== undefined && env[envVar] !== ''`), or document that required string schemas must use `.min(1)`. A loader-level guard is safer than relying on every schema author.

### [OPS-3] `config` loader has no value coercion; boolean/number schemas fail unless authored with `z.coerce` — S3, Confidence M
- **Location:** `packages/core/config/src/dotenv-config-manager.ts:26-45` and `packages/node/logger/src/pino-logger-schema.ts:6`
- **Claim:** `DotenvConfigManager` passes env values as **raw strings**. A schema field typed `z.boolean()` or `z.number()` will fail `schema.parse` on the string `"true"`/`"5005"` because Zod does not coerce. The convention is evidently to use `z.coerce`/preprocess (the `MockConfigManager` special-cases `ZodPipe`/`ZodNumber`/`ZodBoolean` with string values), but the **shipped `PinoLoggerSchema` violates it** with a bare `z.boolean()` for `isExpressContext`.
- **Evidence:** loader: `input[key] = env[envVar];` (string, no coercion). Schema: `isExpressContext: z.boolean(),` — parsing `"true"` from `PINO_LOGGER_ISEXPRESSCONTEXT` through this loader throws `Expected boolean, received string`.
- **Impact:** A footgun in the shared config primitive: any consumer wiring a boolean/number config field through the canonical loader gets a boot-time parse failure unless they remember `z.coerce`. It fails loudly (not silent), but it is an easy way to break a service's boot and it contradicts the loader's own documented purpose. The logger schema demonstrates the trap is live.
- **Suggested action:** Either coerce in the loader for primitive types, or document the `z.coerce` requirement and fix `PinoLoggerSchema` to `z.coerce.boolean()` (and audit other schemas). Confirm how services actually construct `PinoLoggerConfig` (in-process vs. via the loader) to size the blast radius.

### [OPS-4] `logger` production stdout path is gated on `isExpressContext`; the fallback uses a Fargate-unsafe transport — S3, Confidence M
- **Location:** `packages/node/logger/src/pino-logger.ts:172-241`
- **Claim:** The reliable prod path (main-thread `pino.destination` on stdout → CloudWatch) fires only when `NODE_ENV==='production' && isExpressContext`. A prod service that does not set `isExpressContext=true` falls through to the transport-target path, whose worker-thread transport the code itself documents as crashing on process fds in Fargate.
- **Evidence:**
  ```ts
  if (env === 'production' && isExpressContext) {
    const dest = pinoFn.destination({ dest: logFile ?? 1, sync: false });  // reliable
    ...
    return;
  }
  ...
  // "pino's transport mechanism runs in a worker thread that crashes on process
  //  fds (/dev/stdout, /proc/1/fd/1) in Fargate"
  ```
- **Impact:** A single missed env flag (`PINO_LOGGER_ISEXPRESSCONTEXT`) silently downgrades a production ECS/Fargate service to the known-broken transport path — logs may not reach CloudWatch. Since `isExpressContext` is a required schema field with no default, the safety depends entirely on every service's CFN template setting it correctly.
- **Suggested action:** In `NODE_ENV==='production'`, default to the direct-destination path regardless of `isExpressContext` (or hard-fail if a worker transport would be selected in production). Don't let a missing boolean route prod logging into the documented-broken path.

### [OPS-5] `saga-stack-cli` manifest wires the deprecated `JANUS_REQUIRED` alias, not `DEV_PERIMETER_ENABLED` — S3, Confidence M
- **Location:** `packages/node/saga-stack-cli/src/core/manifest/services.ts:91,168,197,379,564,597,630`
- **Claim:** The local dev-stack manifest disables the perimeter via `JANUS_REQUIRED: 'false'`, which `api-util`'s `loadDevPerimeterConfig` explicitly documents as a deprecated alias honored "for one release" (with a deprecation warning). When the alias is removed, these services default the perimeter **ON** in the local stack and 401 local S2S calls. Additionally, several janus-adjacent services in the manifest (`sis-api`, `sessions-api`, `content-api`, `ads-adm-api`, `coach-api`) set neither flag.
- **Evidence:** `services.ts:91` `JANUS_REQUIRED: 'false',` (repeated); `api-util/src/utils/dev-perimeter-config.ts:29` "the legacy env name `JANUS_REQUIRED` is still read as an alias for one release (deprecation warn)."
- **Impact:** Local/dev-stack breakage risk on the next `api-util` major (perimeter defaults ON → local S2S 401s), plus per-launch deprecation-warning noise now. **Not a production risk** — this CLI has no prod launch path and only ever writes the flag as `false`; the prod-enable protection lives in the boot guard (OPS positive, below). Confidence on the flag-name drift is high; on the "unset services will 401" consequence it is medium (depends on which manifest services actually mount the perimeter, unverifiable from soa alone).
- **Suggested action:** Rename the manifest keys to `DEV_PERIMETER_ENABLED: 'false'` and set it uniformly for every service that mounts the perimeter, before the legacy alias is dropped.

### [OPS-6] `aws-util` clients use SDK defaults for retry/throttling and a hardcoded region — S3, Confidence M
- **Location:** `packages/node/aws-util/src/secret-helper.ts:10,21,31`
- **Claim:** `SecretsManagerClient`/`STSClient` are constructed with only `{ region }` — no `maxAttempts` or `retryMode: 'adaptive'` for throttle resilience — and the region is a hardcoded module constant (`AWS_REGION = 'us-west-2'`), not env-overridable.
- **Evidence:** `export const AWS_REGION = 'us-west-2';` … `new SecretsManagerClient({ region: AWS_REGION });` … `new STSClient({ region: AWS_REGION });`
- **Impact:** Low at current scale — SDK v3 defaults (3 attempts, standard backoff) are reasonable. But under fleet-wide fan-out (many tasks fetching secrets on cold-start / rotation) `adaptive` retry mode would be safer against Secrets Manager throttling, and the hardcoded region blocks any future non-us-west-2 deploy without a code change.
- **Suggested action:** Set `retryMode: 'adaptive'` (and an explicit `maxAttempts`) on the clients; source region from `process.env.AWS_REGION` with the current value as fallback.

### [OPS-7] Observability is fully opt-in with no default head sampling — S3, Confidence L
- **Location:** `packages/node/observability/src/tracing.ts:38-84`, `src/metrics.ts:52-58`
- **Claim:** `initTracing`/`createObservability` are libraries a service must remember to call; nothing enforces that a deployed service wires tracing or `/metrics`. The `NodeSDK` is constructed with no explicit sampler, so it relies on OTel env-var sampling (`OTEL_TRACES_SAMPLER`) or the DD agent for volume control — there is no in-code head-sampling default.
- **Evidence:** SDK built with `traceExporter` + `instrumentations` only; no `sampler`. Metrics registered lazily via `addOutbox`/`addConsumer`, invoked by the service, not centrally.
- **Impact:** "Deployed with NO observability" is possible by omission (inherent to a library, but there is no lint/boot check). At prod scale, absent an env sampler every request emits a full span waterfall to the collector; acceptable if DD ingestion sampling is configured, but worth an explicit default.
- **Suggested action:** Document/require the observability wiring in the service bootstrap (or provide a single `bootstrapService()` that wires logger+tracing+metrics+health together), and set a sane `OTEL_TRACES_SAMPLER` default in the service templates.

### [OPS-8] Dead/duplicate `config-manager.ts` alongside the real modules — S4, Confidence H
- **Location:** `packages/core/config/src/config-manager.ts` (vs. `dotenv-config-manager.ts` + `mocks/mock-config-manager.ts`)
- **Claim:** `config-manager.ts` re-declares `DotenvConfigManager` and `MockConfigManager` identically to the two files `index.ts` actually exports from. It is orphaned (not referenced by `index.ts`).
- **Evidence:** `index.ts` exports `DotenvConfigManager` from `./dotenv-config-manager.js` and `MockConfigManager` from `./mocks/mock-config-manager.js`; `config-manager.ts` contains a third, unexported copy of both.
- **Impact:** Maintenance hazard — a fix applied to one copy silently misses the other; future readers may edit the dead file. No runtime effect today.
- **Suggested action:** Delete `config-manager.ts`.

### [OPS-9] `saga-stack-cli` pins zod 3 while the rest of the workspace is on zod 4 — S4, Confidence M
- **Location:** `packages/node/saga-stack-cli/package.json:66` (`"zod": "3.25.67"`) vs. all other soa packages (`"zod": "^4.4.3"`)
- **Claim:** The CLI is the one workspace package on zod 3; every other soa package is on zod 4. As a leaf/bin package this is acceptable in isolation, but it is the sole internal inconsistency in an otherwise-uniform zod pin, and the repo's own contract to downstreams is "match soa versions exactly."
- **Evidence:** grep of `"zod"` across `packages/*/*/package.json` shows uniform `^4.4.3` except `saga-stack-cli` at `3.25.67`.
- **Impact:** None at runtime (CLI is a standalone bin, not consumed as a library type surface). Flagged only as the workspace-consistency exception the review asked about. Note `api-util` deliberately keeps its public types zod-agnostic precisely because some downstreams are still on zod 3 — so the split is understood, not accidental.
- **Suggested action:** None required; align to zod 4 opportunistically when the CLI's oclif/deps allow, to keep the workspace single-versioned.

---

## Positives worth recording

- **Dev-perimeter prod guard is correct and fail-safe** (`api-util/src/utils/dev-perimeter-production.ts`): refuses boot when the perimeter is ON in `NODE_ENV=production`; parse-layer fail-safe means only the literal `"false"` disables the perimeter, so a typo keeps recon protection ON. The task's specific concern — "can a prod launch-plan wrongly enable the perimeter?" — is **negative**: the CLI has no prod launch path and only ever writes the flag as `false`, and the boot guard independently blocks perimeter-ON in prod.
- **Health/readiness primitives are strong** (`health/src/readiness.ts`): per-probe hard timeouts, tri-state ready/disabled/error, 200/503 contract keyed to the ALB matcher, mounted before the auth perimeter.
- **Launch planner is pure and fail-fast** (`saga-stack-cli/src/core/launch-plan.ts`): missing tokens throw with service+key context rather than passing through silently.
- **Observability metric cardinality is bounded** (`metrics.ts:classifyReason`) and gauge-collect failures are themselves counted + logged; spans are PII-sanitized before export.

---

## Areas reviewed / not reviewed

**Reviewed (source read):** `saga-stack-cli` manifest (`services.ts`) + launch planner (`launch-plan.ts`); `observability` (`tracing.ts`, `metrics.ts`, `error-middleware.ts`, `index.ts`); `health` (`health.ts`, `readiness.ts`); `config` (all `src/*.ts`); `aws-util` (`secret-helper.ts`, `index.ts`); `logger` (`pino-logger.ts`, `pino-logger-schema.ts`); `api-util` dev-perimeter config + prod guard; workspace zod/otel/prom version pins.

**Not reviewed / skipped:** `saga-stack-cli` runtime layer (`src/runtime/**` — spawning, snapshot/reset/rollback mechanics beyond the pure planner), seed/flow subsystems, and the CLI command surface; `span-sanitizer.ts` internals (noted as present, not line-audited); the event-* family (outbox/consumer/envelope) except as consumed by observability types; `postgres`/`redis-core`/`rabbitmq`/`db` connection-pool tuning; `api-core` server bootstrap; all `apps/**`, `infra/**`, and `python/**`. The "no coercion" consumer-wiring blast radius (OPS-3) and the "unset services 401" consequence (OPS-5) were not verified against downstream repos, which are outside this checkout's scope.
