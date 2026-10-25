# @saga-ed/soa-lane-guard

Fail-closed boot guard for the prod-profile regression lanes (`LANE=twin|mirror`): services run against scrubbed prod-mirror data in the dev account and must never reach prod side effects. Contract: hipponot/iac `docs/regression-suite/twin-lane-contract.md`. Defense in depth only; the egress security group is the network boundary.

## Activation

Keyed on the infra-set `LANE` env var, independent of `EXEC_ENV` (`EXEC_ENV=prod` on a lane is expected).

| `LANE` | Behaviour |
|---|---|
| unset, empty, `none` | no-op |
| `twin`, `mirror` | all checks run; violations are collected and thrown as one `LaneGuardError` |
| anything else | fail closed (`lane-identity`) |

Messages name env vars, never values; URL credentials and account ids are never printed.

### Migration from 0.1.x (`EXEC_ENV=mirror`)

- Set `LANE=mirror` in the task definition.
- Deprecated alias (removal pending): with `LANE` unset, `EXEC_ENV=mirror` still activates the guard as `LANE=mirror` and emits a `DeprecationWarning`. `LANE=none` with `EXEC_ENV=mirror` fails closed.
- Breaking within 0.x: on a lane, an omitted `accountId` now fails closed (`aws-account`) instead of skipping the check. Resolve it from ECS task metadata or STS.

## Usage

```ts
import { assertLaneSafe } from '@saga-ed/soa-lane-guard';

// first thing at boot, before creating any client
assertLaneSafe(process.env, { accountId });
```

## Checks (on a lane)

| Check | Violation |
|---|---|
| `lane-identity` | `LANE` unknown, or `LANE=none` with `EXEC_ENV=mirror` |
| `dd-env` | `DD_ENV` unset/empty or `prod`/`production`; `deployment.environment` prod in `OTEL_RESOURCE_ATTRIBUTES` or `OTEL_DEPLOYMENT_ENVIRONMENT` |
| `aws-account` | `accountId` omitted, or not in `allowedAccountIds` (default dev `396913734878`) |
| `prod-secret-path` | env value referencing a `/prod/` or `/shared/infra/prod/` SSM path while the account is not a verified allowed account. Allowed in the dev account; the guard cannot verify the value points at lane resources. |
| `prod-host` | `amqp(s)://`, `redis(s)://`, `mongodb(+srv)://`, `postgres(ql)://` URL (any host in the list), or `PGHOST`/`*_HOST` var for postgres/redis/mongo/rabbit, matching `prodHostPatterns` (default: a `prod`/`production` label segment) |
| `prod-public-host` | any host equal to or under a prod public apex (default `saga.org`, `sagaops.org`) in a URL of any scheme in any env value, or in a bare-host value of a var named `*HOST`, `*HOSTNAME`, `*DOMAIN` or `*ENDPOINT`. See [Prod public hosts](#prod-public-hosts-030). |
| `ses` | `MAIL_PROVIDER=ses` or any non-empty `MAIL_SES_*` (no sandbox signal is defined yet) |
| `partner-egress` | non-empty `CLEVER_*`, `*PARTNER*WEBHOOK*`, or `*WEBHOOK*URL*` |

### 0.3.0

- New check `prod-public-host`; configs that passed 0.2.x can now be rejected (e.g. `IAM_API_URL=https://iam.saga.org`). TypeScript consumers with an exhaustive `switch` on `LaneViolation['check']` need a new case.

### Prod public hosts (0.3.0)

A twin is a prod-config copy running in the dev account; a prod service URL it forgets to override calls prod. Every env var (name and host only are reported, never the value) is scanned:

- Hosts are extracted from every `scheme://` URL (any scheme, including inside JSON and comma/space-separated lists, `{node}` templates, userinfo and ports stripped) and from bare-host values of `*HOST`/`*HOSTNAME`/`*DOMAIN`/`*ENDPOINT` vars. Email addresses are not hosts.
- Rejected: a host equal to or under an entry of `prodPublicApexes`, unless it is equal to or under an entry of `allowedHostSuffixes`.
- Skipped: vars whose name matches `nonEgressVarPatterns`.

| Option | Default (each replaces the default; spread the exported `DEFAULT_*` to extend) |
|---|---|
| `prodPublicApexes` | `DEFAULT_PROD_PUBLIC_APEXES`: `saga.org`, `sagaops.org` (dev uses `wootdev.com`/`wootops.org`) |
| `allowedHostSuffixes` | `DEFAULT_ALLOWED_HOST_SUFFIXES`: `internal.saga.org`, `dbs.internal` (dev-VPC private zones, twin-lane-contract rules 5-6) |
| `nonEgressVarPatterns` | `DEFAULT_NON_EGRESS_VAR_PATTERNS`: `*CORS_ORIGIN(S)`, `*ALLOWED_ORIGIN(S)`, `*COOKIE_DOMAIN`, `*ISSUER`, `SAML_SP_ENTITY_ID`. Issuers are compared with the token `iss` claim and cookie domains and CORS origins are inbound; JWKS and API URLs are separate vars and stay checked. |

Not covered: values the guard cannot see (schema defaults in app code when the var is absent, SSM/Secrets Manager-resolved values), and a bare host inside a JSON value with no URL scheme.

### 0.2.1

- `opts.identity` (soa-env's `EnvIdentity`) is cross-checked against the raw env: a lane mismatch in either direction is a `lane-identity` violation, including identity `twin`/`mirror` with raw `none`. `identity.account.id` supplies `accountId` when none is passed. Raw-env checks are unchanged and independent.
- `MAIL_PROVIDER=capture` is accepted on a lane; only `ses` and `MAIL_SES_*` are violations.

`checkLaneSafety(env, opts)` returns the violations without throwing; `resolveLane(env)` returns the resolved lane.
