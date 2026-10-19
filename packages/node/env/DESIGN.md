# @saga-ed/soa-env: design (soa#515, M2)

Status: ACCEPTED 2026-10-18 (design review SHIP after 2 rounds); implementation landed in this PR (section 9 step 1, minus the /ss wiring, which is deferred).

Tracking: saga-ed/soa#515, part of hipponot/iac#897. Classes: C1 (env-gated branches), C3 (one client path), C10 (side-effect switches visible). Contract: iac `docs/regression-suite/twin-lane-contract.md` (iac#898). Related: lane-guard (soa#516/#519), M1 prod-config-only (ci-actions#138).

## 1. Problem

Services branch on env names (`NODE_ENV==='production'`, `EXEC_ENV==='prod'`, `SAGA_ENV`) at many call sites. Prod-only branch bodies (RDS IAM token, pinned CA, fatal boot guards, KMS signing, real mail) never run before prod, so each is a latent C1/C3 incident.

Fix: one module reads identity and returns declared capabilities. Call sites read capabilities. Branch bodies execute in every env; only the capability values differ.

## 2. Survey (read-only, fresh ~/dev clones)

Patterns: `EXEC_ENV`, `NODE_ENV`, `SAGA_ENV`, `IsProd|isProd|IS_PROD|isProduction`, `=== 'prod'|'production'`, `!==` forms. Scanned `*.ts,*.tsx,*.js,*.mjs,*.cjs` in rostering, program-hub, student-data-system, coach, saga-dash, soa. Excluded: tests/specs/e2e, generated code (prisma), in-tree `worktrees/`, `.svelte-kit`, `scripts/`, comment lines, node_modules/dist.

Result: 273 code lines (rostering 65, student-data-system 90, program-hub 36, coach 36, soa 32, saga-dash 14). By variable: NODE_ENV 115, EXEC_ENV 69, SAGA_ENV 18, IsProd-style locals 26 (lines can match more than one). 73 lines are exempt-class (below); 200 are runtime identity reads.

| Category (runtime, 200 lines; keyword-classified, approximate) | Count | Examples |
|---|---|---|
| Auth/authz (perimeter, KMS signing, permissive checker) | ~52 | `coach/apps/node/coach-api/src/authz/authz-checker-bindings.ts` (ladder keyed on `EXEC_ENV` set/unset); `rostering/apps/node/iam-api/src/services/jwt-issuer.service.ts:15`; `soa/packages/node/api-util/src/utils/dev-perimeter-production.ts:54` |
| DB credential / client | ~33 | `rostering/apps/node/authz-api/src/db-init.ts:43` (module-level `USE_IAM_AUTH`); `program-hub/apps/node/sessions-api/src/prisma/client.ts:44`; `coach/packages/node/coach-db/src/client.ts:30`; `soa/packages/node/postgres/src/aws-postgres-loader.ts` (`env: dev|mirror|prod`) |
| Fail-fast / boot guards | ~23 | `rostering/apps/node/iam-api/src/main.ts:141,155,220,230,285,343,358,377,398`; `.../config/assert-production-config.ts:65`; `rostering/apps/node/sis-api/src/main.ts:61`; `soa/packages/node/rabbitmq/src/connection-manager.ts:531` |
| CORS/CSP/cookies/host/domain | ~12 | `coach/apps/node/coach-api/src/main.ts:232,353`; `program-hub/apps/node/content-api/src/services/thumbnail-cdn-host.ts:29`; `soa/packages/node/api-util/src/utils/cors.ts:70` |
| Logging/telemetry | ~13 | `soa/packages/node/logger/src/pino-logger.ts:157`; `soa/packages/node/health/src/health.ts:102` (reports `EXEC_ENV` as `environment`) |
| Integrations/side effects (lake, outbox, partners) | ~5 + unclassified | `rostering/apps/node/iam-api/src/bin/lake-export.ts:38`; `student-data-system/apps/node/transcripts-api/src/inversify.config.ts:51-55,145` (`SAGA_ENV` mirror/prod) |
| Feature toggles/dev tools | ~2 | iam-api demo page mount `main.ts:463` |
| Unclassified remainder | ~60 | mostly boot-guard and auth lines whose text lacks my keywords; counts above are floors, not exact |

Mail: no direct env comparison found in the 200 lines; it is driven by `MAIL_PROVIDER` (`soa/packages/node/mailer/src/config.ts:18`, default `stub`), with the iam-api stub refusal under `NODE_ENV=production` in the fail-fast bucket. Mail is still a first-class capability (`mailSink`).

Exempt classes (73 lines; lint must allow them without a baseline entry):
- CLI operator arguments, not runtime identity: `coach-concierge sync-org.mjs` (`source === 'prod'`), `targets.mjs`, `iam-db provision-service-client.ts` (`--env`), `legacy-demo-import`, `iam-api/src/bin/*`, `*/prod-migrate.ts`.
- Build-time `NODE_ENV`: `tsup.config.ts`, `svelte.config.js`, saga-stack-cli manifests that SET `NODE_ENV: 'development'` for child processes (writes, not reads).

Findings that drive the design:
- Shared soa packages are themselves violators (`api-util` cors and dev-perimeter, `rabbitmq`, `logger`, `postgres`). They must take injected capabilities before services can migrate.
- Module-top-level env reads (`export const USE_IAM_AUTH = ...`) freeze identity at import time and defeat injection.
- `coach` treats "no `EXEC_ENV`" as permissive authz (`authz-checker-bindings.ts:19`). Under fail-closed parsing that same state is the prod profile, so coach is a direct inversion and needs an explicit local declaration (section 4).
- /ss (`saga-stack-cli`) sets `NODE_ENV=development` and no `EXEC_ENV`; unit tests set neither.

## 3. Identity axes (from the lane contract)

| Axis | Source | Used for |
|---|---|---|
| Behaviour profile | `EXEC_ENV` / `NODE_ENV` | Which code branches run. `prod` on prod, the twin and (after flip) dev-main |
| Lane | `LANE=twin\|mirror\|none` (infra-set in the task definition) | Side-effect fencing, guard, telemetry fencing |
| Telemetry env | `DD_ENV` / `deployment.environment` | Datadog tag only. Never derived from profile |
| Account | ECS task metadata / STS, or the local declaration | Authoritative "is this prod" |

Ownership (review round 1): soa-env owns `parseLane`, `resolveAccount` and the single local declaration. The core has no dependencies; STS lookup is an injected `AccountResolver` or the `@saga-ed/soa-env/aws` subpath. lane-guard and soa-health import soa-env; lane-guard keeps its raw-env checks as an independent cross-check.

`parseLane` is strict on `LANE` alone (trim, lowercase; unset/empty/whitespace = `none`; anything else = invalid). The `EXEC_ENV=mirror` alias exists only in lane-guard 0.2.x (soa#519, removed in 0.3.0); soa-env throws an explicit "set LANE=mirror" error when it sees `EXEC_ENV=mirror`.

## 4. Fail-closed parsing and the single local declaration

Rule: unknown or unparseable means deployed prod behaviour with every invariant of the matching row enforced; if no row matches, boot fails.

- Account: ECS task metadata (`ECS_CONTAINER_METADATA_URI_V4`) then the injected resolver. Failure returns undefined or throws; never a default. An unresolved account stops boot (contract rule 3).
- The local declaration is `SAGA_LOCAL=1`. soa-env is its only owner; soa-health and everything else consume it (section 9, note on soa#521).
- `SAGA_LOCAL=1` is REFUSED (boot error) when any of these is present: `ECS_CONTAINER_METADATA_URI`, `ECS_CONTAINER_METADATA_URI_V4`, `AWS_EXECUTION_ENV`, `AWS_LAMBDA_FUNCTION_NAME`. Under `SAGA_LOCAL=1` a resolver failure resolves to `local`; only a positive prod-account result refuses (a laptop holding prod credentials). Consequence for /ss: a service that injects the `/aws` STS resolver refuses to boot under prod credentials (e.g. an exported `AWS_PROFILE=saga`); without the resolver, `AWS_*` is never read. /ss services use ambient AWS credentials locally (connectv3-api S3, staff-admin-bff, KMS/key loaders), so saga-stack-cli must REPLACE prod credentials with a dev profile for service children rather than delete `AWS_*`. That lands with the first resolver consumer (the §9 step 4 authz-api pilot); the runner that runs `co:login` and the seed S3 restore stays unscrubbed.
- `SAGA_LOCAL=1` yields account kind `local`. The /ss launch env sets it (saga-stack-cli `resolveLaunchEnv` and up.sh `services_up`). A service repo's vitest setup sets it for `main.ts` boot tests when that repo adopts soa-env (§9 step 4); soa itself boots no `main.ts`, and unit tests use `testEnv()`.
- Conflicting signals (prod account with `EXEC_ENV=dev`, `SAGA_LOCAL` with `LANE=twin`) throw `EnvIdentityError`.

## 5. Capabilities and the invariant table

Interface: `src/types.ts`, `src/index.ts`. Capabilities: `credentialSource` (`iam-token|static`), `tls`, `failFast`, `mailSink` (`ses|capture|stub`), `corsOrigins`, `cookieDomain`, `trustProxyHops`, `telemetryEnv`, `devPerimeter` (`on|off`), `permissiveAuthz` (boolean), `logFormat`, `logLevel`, `outbound.<integration>` (`live|sink|off`).

`devPerimeter` and `permissiveAuthz` are separate switches. The dev perimeter is a protection (recon-blocking gate; default ON in the dev overlay (may be off: rostering `.github/workflows/sandbox-deploy.yml` ~L327 passes `DevPerimeterEnabled=false` for the e2e composition), forced off in R1/R2: `dev-perimeter-production.ts`). Permissive authz is a bypass (coach `COACH_AUTHZ_ALLOW_ALL`); it is legal only in the `local` row.

Invariants are keyed on ACCOUNT x LANE, not on behaviour profile. Profile is a derived input to the row, never a selector. "Real side effects required" depends on account + lane, so the twin can boot.

| Row | Account | Lane | Required | Forbidden |
|---|---|---|---|---|
| R1 prod | prod | none | `failFast`, `credentialSource=iam-token`, tls with CA, `mailSink=ses` (only when the service's declaration lists mail), `outbound.* = live` per declaration, `telemetryEnv=prod`, `devPerimeter=off` | `permissiveAuthz`, `capture`/`stub` mail, sinks, dev origins |
| R2 lane | dev | twin or mirror | `failFast`, `credentialSource=iam-token`, tls, `devPerimeter=off`, `telemetryEnv != prod`, `mailSink=capture`, every `outbound.* in {sink, off}` | `permissiveAuthz`, `mailSink=ses`, `live` outbound, prod-named SSM values that do not resolve to lane resources (guard) |
| R3 dev overlay | dev | none | `devPerimeter in {on, off}` (default on; only R1 and R2 force off), `telemetryEnv=dev`, dev bindings (`credentialSource` per service SSM; `static` allowed), `mailSink in {stub, capture}`; `failFast` follows the legacy NODE_ENV branch until the service flips | `permissiveAuthz`, `mailSink=ses` to real recipients, prod secret paths |
| R4 local | local | none | `credentialSource=static`, `mailSink in {stub, capture}`, `outbound.* in {off, sink}` | prod secret paths, `LANE != none` |
| - | prod | twin or mirror | boot fails (lane in the prod account) | everything |
| - | any | invalid | boot fails | everything |
| - | prod | none, with `EXEC_ENV=dev` | boot fails (conflict) | everything |

R3 transitional input: in 0.1.0, `EXEC_ENV=dev` is accepted as an input to R3 only. The end state is dev-main running `EXEC_ENV=prod` on R3 capabilities (prod code paths, dev bindings). Flip a service's dev-main to `EXEC_ENV=prod` only once that service's lint baseline is 0, because legacy `NODE_ENV` branches flip with it.

Every current environment maps to exactly one row (values marked [assumed] are from docs and memory, to be verified per service in the implementation PR):

| Environment | EXEC_ENV | NODE_ENV | LANE | Account | Row |
|---|---|---|---|---|---|
| prod | prod | production | none | prod | R1 |
| twin lane | prod | production | twin | dev | R2 |
| mirror lane | prod (`mirror` legacy, throws "set LANE=mirror") | production | mirror | dev | R2 |
| dev-main | dev (-> prod after flip) | development (-> production) | none | dev | R3 |
| container-per-PR preview | dev (verified for rostering; [assumed] for program-hub, sds, coach) | development (same) | none | dev | R3 |
| training | dev (verified for rostering; [assumed] elsewhere) | development (same) | none | dev | R3 |
| saga-sandbox | dev (verified for rostering; [assumed] elsewhere) | development (same) | none | dev | R3 |
| /ss (saga-stack-cli) | unset | development | none | local (`SAGA_LOCAL=1`) | R4 |
| CI unit/integration tests | unset | test | none | local (`SAGA_LOCAL=1` via test setup) | R4 |

`createEnv` evaluates the table and throws one `EnvInvariantError` listing all violations (names, never values). Lane-guard remains the independent cross-check on raw env.

Mail on the lane: `mailSink=capture` requires a `CaptureMailAdapter` in `@saga-ed/soa-mailer` (mailer enum becomes `stub|ses|capture`; capture writes the rendered message to a lane-owned sink such as a lane SQS queue or S3 prefix and never to a recipient). Follow-ups: (a) iam-api's stub-mailer refusal is rewritten to read the `mailSink` capability (refuse `stub` only in R1); (b) lane-guard's `ses` check must accept `MAIL_PROVIDER=capture` (lane-guard follow-up issue); (c) the mailer's `mailProvider: z.enum([...]).default('stub')` (`mailer/src/config.ts:18`) violates M1's no-silent-default rule and the key becomes required.

## 6. Binding to config (M1 composition)

M1 (ci-actions#138) fixes WHERE values live: the prod samconfig stanza is complete; non-prod stanzas are overlays. soa-env fixes WHAT is read: `CapabilityDeclaration.keys` maps each capability to ONE config key (no composite switches).

- The M1 render/policy gate asserts per-stanza values for those keys at PR time (prod stanza: `mail=ses`, `credential=iam-token`; lane overlay: `mail=capture`, `outbound.*=sink`). The module asserts the invariants at boot. Neither duplicates the other.
- `ConfigSource` is injected: SSM parameters and template env vars in deployed envs, an in-memory map in tests. `process.env` is read only in `loadEnv`.
- Template `Default:` values for capability keys are forbidden by M1; a missing key throws (no silent dev default).
- Code reads capabilities; it never compares them to env names.
- Config value encodings (0.1.0; the M1 render gate in ci-actions#138 must match): booleans `true|false`; `tls` = `off|required|required:<caBundlePath>`; `corsOrigins` = comma list, entries wrapped in slashes are RegExp; `outbound` = `name=live|sink|off,...` (every declared integration must appear; unknown names are an error). `mailSink` is optional in a declaration: no key means no mail, the capability reads `stub`, and the R1/R2 mail checks are skipped. The six service-shaped capabilities (`cookieDomain`, `corsOrigins`, `trustProxyHops`, `devPerimeter`, `logFormat`, `logLevel`) are optional the same way: an undeclared one is not read, reads `undefined`, and its row checks are skipped; a declared one with a missing or invalid value still violates. The core five (`credentialSource`, `tls`, `failFast`, `telemetryEnv`, `permissiveAuthz`) are always required.

## 7. One client path and testability (C3)

C3 closes only if each client has ONE construction and only the supplier differs: one `PostgresProvider` build, `credentialSource` selects the password supplier (RDS IAM token vs static), and the pinned CA applies whenever `tls.caBundlePath` is set.

- `createEnv(decl, identity, config)` is pure; `loadEnv` is the single side-effecting entry. No module-top-level reads (`USE_IAM_AUTH` pattern).
- `@saga-ed/soa-env/testing` exports `testEnv(overrides)`: R4 identity with dev bindings. Unit tests run the same branch bodies with both `credentialSource` values; /ss supplies the same through `SAGA_LOCAL=1` plus a local `ConfigSource`.
- Capabilities are injected through DI, not imported as a global.

## 8. Lint (`@saga-ed/soa-env/eslint`)

Lives in the new package (subpath export); `packages/core/eslint-config/base.js` is not edited. ESLint stays at 8.57 (no upgrade now). Frontend `import.meta.env` is out of scope.

Rule `no-env-identity` is PURE (no file or baseline state, so ESLint caching stays correct). It reports:
- Member reads of `EXEC_ENV`, `NODE_ENV`, `SAGA_ENV`, `LANE`, `DD_ENV` on any object, including destructuring and computed keys.
- Comparisons of an env-derived expression against `'prod'`, `'production'`, `'mirror'`, `'twin'`, `'staging'`. The narrow heuristic treats a left side as env-derived when its name matches `/env|profile|lane/i` or it traces to a flagged read. `mode` is NOT in the regex.
- Not reported: `env: { NODE_ENV: 'development' }` object literals (child-process writes), type positions.

Strict audit: a separate report-only run flags every `'prod'`/`'production'` literal comparison; it does not gate and feeds the baseline sizing.

Allow-list: (1) the env module (`packages/node/env/src/**`, consumer `src/env/**`); (2) `exempt` globs with a required reason (CLI operator args `**/bin/**`, `*/prod-migrate.ts`, `coach-concierge`; build config `tsup.config.*`, `svelte.config.*`); (3) inline disables with a required description.

Ratchet lives in a CI wrapper, `soa-env-lint-ratchet`, which runs `eslint --format json` and compares per-file counts of this rule with a committed baseline. The baseline file is shaped like ESLint 9's `eslint-suppressions.json` (`{ "<file>": { "@saga-ed/soa-env/no-env-identity": { "count": N } } }`), so a later ESLint 9.24+ upgrade is a rename. The wrapper fails when a file's count exceeds baseline (new violation) and when it is below baseline ("baseline stale: lower it"); `--write` regenerates it locally and is refused in CI. New files have an implicit baseline of 0.

## 9. Migration plan

Order follows the contract (rule 4): authz-api, iam-api, sis-api, then fleet (the issue lists iam-api first; authz-api's violation is smallest and isolated).

0. This PR: design review (round 1 resolved in the PR body).
1. soa implementation PR: package scaffolding, `parseLane`/`resolveAccount`/`parseIdentity`/`createEnv`/`loadEnv`/`testEnv`, lint rule + ratchet wrapper, `SAGA_LOCAL=1` in /ss manifests and vitest setup, tests. Publish `@saga-ed/soa-env` 0.1.0.
2. soa's own packages reach baseline 0 BEFORE any service flips NODE_ENV: `api-util` cors/dev-perimeter, `rabbitmq` (`failFast`), `logger` (plain `LOG_FORMAT`/`LOG_LEVEL` keys), `postgres` loader (`credentialSource`+`tls` instead of `env`), `mailer` (`capture` adapter, required `mailProvider`). In each shared package the capability wins over the env fallback, with a once-only deprecation warning when the fallback is used.
3. lane-guard and soa-health import soa-env. Health reports `profile`, `lane`, `telemetryEnv`, `accountKind`; `environment` stays as a deprecated alias. Note on soa#521 (not edited here): it currently uses `EXEC_ENV=local|ci` as its local declaration; once soa-env 0.1.0 publishes, health switches to the soa-env local declaration (`SAGA_LOCAL=1`) so there is one declaration.
4. Rostering pilot: authz-api (`db-init.ts:43` module-level `USE_IAM_AUTH`, `main.ts`, `prod-migrate.ts`), then iam-api (`main.ts` guards, `assert-production-config.ts`, `lake-export.ts:38`, `jwt-issuer.service.ts`, mailer refusal), then sis-api (`main.ts:61`, Clever/digest as `outbound.*`). Pilot checklist: verify what sis-api prod actually runs for mail (`MailProvider` comes from `vars.ROSTERING_SIS_MAIL_PROVIDER || 'stub'`, `deploy-sis-api.yml:306`) before declaring R1 `mailSink=ses` for it. Tests exercise both capability values on the same path. Lint enabled with a baseline for the rest of rostering. Template changes (`LANE` parameter, telemetry decoupled from `ExecEnv`) are the iac#898 work.
5. Per-service dev-main flip to `EXEC_ENV=prod` only at that service's baseline 0.
6. Fleet follow-ups in order: program-hub, student-data-system (`SAGA_ENV` removed), coach (authz ladder to `permissiveAuthz`, `coach-db client.ts:30`), saga-dash BFFs.
7. Ratchet to zero repo by repo; rule becomes a required check.

Rollback: each service PR is revertible; the module is additive; deprecated env fallbacks stay until the last consumer migrates.

## 10. Open questions

1. Preview, training and sandbox values are verified for rostering (EXEC_ENV=dev, NODE_ENV=development, dev stanza); verify per service for program-hub, sds and coach before their rollout.
2. Capture sink target: DECIDED 2026-10-18, an S3 prefix (no consumer needed, durable, test-inspectable, no 256KB limit); iac provisions it before the iam-api lane pilot. 0.1.0 needs only the `capture` enum value and the invariant.
3. Strict-literal audit scope and whether it eventually gates.
