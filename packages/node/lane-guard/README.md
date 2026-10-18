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
- Deprecated alias, removed in 0.3.0: with `LANE` unset, `EXEC_ENV=mirror` still activates the guard as `LANE=mirror` and emits a `DeprecationWarning`. `LANE=none` with `EXEC_ENV=mirror` fails closed.
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
| `ses` | `MAIL_PROVIDER=ses` or any non-empty `MAIL_SES_*` (no sandbox signal is defined yet) |
| `partner-egress` | non-empty `CLEVER_*`, `*PARTNER*WEBHOOK*`, or `*WEBHOOK*URL*` |

`checkLaneSafety(env, opts)` returns the violations without throwing; `resolveLane(env)` returns the resolved lane.
