# @saga-ed/soa-env: design (soa#515, M2)

Status: DRAFT for design review. Design and interface stubs only. No `package.json` yet: `pnpm-workspace.yaml` globs `packages/node/*`, so adding one would change `pnpm-lock.yaml`. Scaffolding lands with the implementation PR.

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
| Behaviour profile | `EXEC_ENV` / `NODE_ENV` | Which code branches run. `prod` on prod and on the lane. |
| Lane | `LANE=twin\|mirror\|none` (infra-set in the task definition) | Side-effect fencing, guard, telemetry fencing |
| Telemetry env | `DD_ENV` / `deployment.environment` | Datadog tag only. Never derived from profile |
| Account | ECS task metadata / STS | Authoritative "is this prod" |

`parseLane` is strict on `LANE` alone (trim, lowercase; unset/empty/whitespace = `none`; anything else = invalid). The deprecated `EXEC_ENV=mirror` alias is lane-guard's migration shim (lane-guard 0.2.0, soa#519, removed in 0.3.0) and stays out of soa-env. Lane-guard will import `parseLane`/identity from soa-env once it exists; until then lane-guard's `resolveLane()` is the reference and should stay a pure function that can be lifted.

## 4. Fail-closed parsing and the local escape

Rule: unknown or unparseable means deployed prod profile with all prod invariants enforced.

- Profile: `prod` unless `EXEC_ENV` is exactly `dev`/`local` AND the account resolves to dev or local. Any other value (including `mirror`, `staging`, typos) is a prod profile. Conflicting signals (e.g. `NODE_ENV=development` with prod account) throw `EnvIdentityError`.
- Account: resolved from ECS task metadata (`ECS_CONTAINER_METADATA_URI_V4`) then STS. Failure returns undefined or throws; never a default. On a lane an unresolved account stops boot (contract rule 3).
- Local escape: `account.kind === 'local'` is legal only when no ECS metadata endpoint exists AND the process declares `SAGA_LOCAL=1`. /ss and test setup must start setting `SAGA_LOCAL=1` (a one-line change in saga-stack-cli manifests `services.ts`, and in vitest/jest setup via `testEnv`). Without it a laptop run is treated as deployed prod and fails closed. `SAGA_LOCAL` is refused if ECS metadata is present, so it cannot be set on a deployed task by accident.
- Migration consequence: coach's "no EXEC_ENV = permissive" rung is replaced by `devAuthSurfaces`, true only with the local declaration or a dev account.

## 5. Capabilities and the invariant table

Interface: `stubs/types.ts`, `stubs/index.ts`. Capabilities: `credentialSource` (`iam-token|static`), `tls`, `failFast`, `mailSink`, `corsOrigins`, `cookieDomain`, `trustProxyHops`, `telemetryEnv`, `devAuthSurfaces`, `outbound.<integration>` (`live|sink|off`).

Invariants are keyed on the right axis. "Real side effects required" depends on account + lane, NOT on behaviour profile, otherwise the twin cannot boot (iam-api already refuses the stub mailer under `NODE_ENV=production`; `mirror-lane.md`).

| Profile | Lane | Account | Required | Forbidden |
|---|---|---|---|---|
| prod | none | prod | `failFast`, `credentialSource=iam-token`, tls with CA, `mailSink=ses`, `outbound.* = live` per declaration, `telemetryEnv=prod`, `devAuthSurfaces=false` | stub mail, sinks, dev origins |
| prod | twin or mirror | dev | `failFast`, `credentialSource=iam-token`, tls, `devAuthSurfaces=false`, `telemetryEnv != prod`, `mailSink in {sandbox-ses, capture}`, every `outbound.* in {sink, off}` | `ses` to real recipients, `live` outbound, prod-named SSM values that do not resolve to lane resources (guard) |
| prod | twin or mirror | prod | none: boot fails (lane in prod account) | everything |
| prod | none | dev | boot fails (prod-profile code, no lane, in dev account) unless a dev-deploy overlay declares it | n/a |
| local | none | local | none required; `credentialSource=static`, `mailSink=stub|capture`, `outbound.* in {off, sink}` allowed | prod secret paths |
| any | invalid | any | boot fails | n/a |

`createEnv` evaluates this table and throws one `EnvInvariantError` listing all violations (names, never values). Lane-guard stays as the independent boot-time cross-check on raw env (defense in depth).

## 6. Binding to config (M1 composition)

M1 ("prod config is the only config; other envs are overlays", ci-actions#138) fixes WHERE values live: the prod samconfig stanza is complete; non-prod stanzas are overlays. soa-env fixes WHAT is read: `CapabilityDeclaration.keys` maps each capability to ONE config key (one key per capability, no composite switches). Consequences:

- The M1 render/policy gate asserts per-stanza values for those keys at PR time (prod stanza: `mail=ses`, `credential=iam-token`; lane overlay: `mail=sandbox-ses`, `outbound.*=sink`). The module asserts the invariants at boot. Neither duplicates the other.
- `ConfigSource` is injected: SSM parameter reads (`/mirror/current/*`, service SSM) and template env vars in deployed envs; an in-memory map in tests. The module never reads `process.env` anywhere except `loadEnv`.
- Template `Default:` values for capability keys are forbidden by M1; a missing key throws (no silent dev default).
- Code reads capabilities; it never compares them to env names. A capability value that implies an environment name (e.g. `telemetryEnv === 'prod'`) is not a branch condition.

## 7. One client path and testability (C3)

C3 closes only if each client has ONE construction and only the supplier differs. Example: one `PostgresProvider` build; `credentialSource` selects the password supplier (RDS IAM token callback vs static) and the pinned CA is applied whenever `tls.caBundlePath` is set. Shared packages (`postgres`, `api-util`, `rabbitmq`, `logger`, `mailer`) take capability inputs; their env-name fallbacks are deprecated.

- `createEnv(decl, identity, config)` is pure; `loadEnv` is the single side-effecting entry, called once at boot. No module-top-level reads.
- `@saga-ed/soa-env/testing` exports `testEnv(overrides)`: prod-profile identity with dev capability bindings (static credential, stub mail sink, `outbound` sinks). Unit tests run the same branch bodies with both `credentialSource` values; /ss supplies the same dev bindings through `SAGA_LOCAL=1` plus a local `ConfigSource`. This is the S-stage evidence for M2.
- Capabilities are injected through DI (inversify binding for `Capabilities`), not imported as a global.

## 8. Lint rule (`@saga-ed/soa-env/eslint`)

Lives in the new package (subpath export); the shared config `packages/core/eslint-config/base.js` is not edited here. Each consumer repo adds the preset. ESLint is 8.57 fleet-wide, so native bulk suppressions (ESLint 9.24+) are unavailable.

Rule `no-env-identity`, error level. It reports:
- Member reads of `EXEC_ENV`, `NODE_ENV`, `SAGA_ENV`, `LANE`, `DD_ENV` on ANY object (`process.env.X`, `env.X`, `opts.env.X`), not just `process.env`, because of the injected `env` parameter pattern.
- Destructuring (`const { NODE_ENV } = process.env`), computed keys with those literals (`env['NODE_ENV']`), and string-literal aliases of the names.
- Comparisons of any expression against `'prod'`, `'production'`, `'mirror'`, `'twin'`, `'staging'` (`===`, `!==`, `==`, `switch case`), unless the left side is not env-derived (heuristic: identifier/member name matches `/env|profile|lane|mode/i` or traces to a flagged read). The heuristic is intentionally narrow to limit false positives; misses fall to review.
- Not reported: assignments that set child-process env (`env: { NODE_ENV: 'development' }` object literals), type-only positions.

Allow-list:
1. Default allow: files under the env module (`packages/node/env/src/**` and each consumer's `src/env/**` re-export shim).
2. Per-glob `exempt` entries with a REQUIRED `reason` for CLI operator args (`**/bin/**`, `*/prod-migrate.ts`, `coach-concierge`, `provision-service-client.ts`) and build config (`tsup.config.*`, `svelte.config.*`, `vite.config.*`).
3. Line-level `// eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- <reason>` requires a reason (enforced via `--report-unused-disable-directives` plus `eslint-comments/require-description`).

Ratchet (no 9.24 suppressions): a committed `.env-identity-baseline.json` maps `file -> count`. The rule (option `baseline`) fails when a file's count exceeds its baseline (new violation), and fails when the count is BELOW baseline ("baseline stale: lower it"), so the number only goes down. `pnpm lint:env-baseline --write` regenerates it and is refused in CI. New files have an implicit baseline of 0. The baseline is deleted when it reaches empty; the rule then stays at plain error. Alternative: upgrade to ESLint 9.24+ and use `eslint-suppressions.json`; the fleet upgrade cost makes the custom baseline the cheaper start.

## 9. Migration plan

Order follows the contract (rule 4): authz-api, iam-api, sis-api, then fleet. (The issue lists iam-api first; authz-api first because its violation is smallest and isolated: `db-init.ts:43`.)

0. This PR: design review. Open questions below resolved.
1. soa: implementation PR (package scaffolding, `parseIdentity`/`createEnv`/`loadEnv`/`testEnv`, lint rule, tests). Publish `@saga-ed/soa-env` 0.1.0 (manual publish workflow, as for other soa packages).
2. soa shared packages (prerequisite, one PR each, backward compatible): `api-util` cors/dev-perimeter take `corsOrigins`/`devAuthSurfaces`; `rabbitmq` takes `failFast`; `logger` takes a log-format/level capability; `postgres` loader takes `credentialSource`+`tls` instead of `env`. Env fallbacks marked deprecated.
3. Pilot, rostering (M if rostering only):
   - authz-api: replace module-level `USE_IAM_AUTH` and the `EXEC_ENV` branches (`db-init.ts:43-44`, `main.ts`, `prod-migrate.ts`) with capabilities. Tests exercise both `credentialSource` values on the same `initDb` path.
   - iam-api: replace the NODE_ENV guards (`main.ts:141,155,220,230,285,343,358,377,398,463,863,1190`, `assert-production-config.ts`, `lake-export.ts:38`, `jwt-issuer.service.ts`) with `failFast`, `devAuthSurfaces`, `outbound.lake`, `mailSink`. `assertProductionConfig` becomes `createEnv` invariants plus its existing config rules.
   - sis-api: `main.ts:61`, Clever/digest switches as `outbound.*`.
   - Enable lint with a baseline for the rest of rostering; template changes (`LANE` parameter, telemetry decoupled from `ExecEnv`) are the iac#898 / ros lane-telemetry work, not repeated here.
4. Fleet follow-ups (separate issues, in order): program-hub (sessions-api `client.ts:44`, scheduling/programs main, thumbnail host), student-data-system (transcripts/chat/ledger/insights/ads-adm; `SAGA_ENV` goes away), coach (authz ladder to `devAuthSurfaces`, `coach-db client.ts:30`), saga-dash BFFs (`staff-admin-console/backend`, `analytics-console/backend`).
5. Ratchet to zero repo by repo; remove baseline files; make rule a required check.

Rollback per step: each service PR is revertible; the module is additive; deprecated env fallbacks stay until the last consumer migrates.

## 10. Open questions

1. Local declaration: is `SAGA_LOCAL=1` acceptable, and who owns the saga-stack-cli change?
2. `health.ts:102` reports `EXEC_ENV` as `environment`; a twin would read "prod". Owned by the health work; should it report `lane` and `telemetryEnv` separately?
3. Dev account deploys of prod-profile code with no lane (dev-main) are marked "boot fails" in the table; dev-main today runs `EXEC_ENV=dev`. Is the profile for dev-main `local`-style (`dev` account kind with dev bindings)? Table row likely needs a `dev` profile value.
4. Does soa-env own account resolution, with lane-guard consuming it (proposed), or does lane-guard keep STS resolution?
5. Heuristic scope of the comparison check vs. a stricter ban on all `'prod'` literals; stricter finds more but needs a bigger baseline.
6. Upgrade to ESLint 9.24+ for native suppressions instead of the custom baseline?
