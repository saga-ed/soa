# @saga-ed/soa-lane-guard

Fail-closed boot guard for the `EXEC_ENV=mirror` regression lane: services run with prod-like config against a scrubbed mirror in the dev account and must never reach prod side effects. Defense in depth only; the egress security group is the network boundary.

No-op unless `EXEC_ENV === 'mirror'`. When mirror, all violations are collected and thrown as one `LaneGuardError`. Messages name env vars, never values; URL credentials are never printed.

## Usage

```ts
import { assertLaneSafe } from '@saga-ed/soa-lane-guard';

// first thing at boot, before creating any client
assertLaneSafe(process.env, { accountId: (await sts.getCallerIdentity()).Account });
```

`accountId` is optional; without it the account check is skipped, so callers should resolve it via STS.

## Checks

| Check | Violation |
|---|---|
| `dd-env` | `DD_ENV` unset/empty or `prod`/`production` |
| `prod-secret-path` | any env value containing `/shared/infra/prod/` |
| `prod-host` | `amqp(s)://`, `redis(s)://`, `mongodb(+srv)://`, `postgres(ql)://` URL (any host in the list), or `PGHOST`/`*_HOST` var for postgres/redis/mongo/rabbit, matching `prodHostPatterns` (default: a `prod`/`production` label segment) |
| `ses` | `MAIL_PROVIDER=ses` or any non-empty `MAIL_SES_*` |
| `partner-egress` | non-empty `CLEVER_*`, `*PARTNER*WEBHOOK*`, or `*WEBHOOK*URL*` |
| `aws-account` | `opts.accountId` not in `allowedAccountIds` (default dev `396913734878`) |

`checkLaneSafety(env, opts)` returns the violations without throwing.
