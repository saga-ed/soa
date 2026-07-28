# Prod-side facts — live discovery for I#375

Answers the open questions in [I#375](https://github.com/saga-ed/soa/issues/375) from **live
read-only AWS reads**, not from `iac` source. Companion to `ss-env.md`, which captures the `ss env`
command surface as it exists before prod support.

- Captured: **2026-07-28**
- Account: `531314149529`, region `us-west-2`, profile `prod_admin` (AdministratorAccess)
- Dev-side comparisons: account `396913734878`, profile `dev_admin`
- All reads were `list`/`describe`/`scan` — nothing was mutated.

> Everything here is **documentation, not config**. The I#355 stance holds: endpoint values stay
> discovered live or overridden per invocation. Nothing below should be hardcoded into a command.

## Q1 — Does prod appear in a dev-platform control-plane ledger? **No.**

Two independent checks, both negative:

- **Dev ledger.** `dynamodb scan --table-name dev-platform-control-plane-environments-dev
  --projection-expression pk` returns **784 distinct `pk` values**. `ENV#main` (dev) and
  `ENV#training` are both present. **Zero** `pk`s match `prod` — the only `prod`-adjacent hits are
  per-service `*-training` rows, no prod row of any shape.
- **Prod account.** `dynamodb list-tables` in `531314149529` returns **9 tables**, none of them a
  control plane:
  `coach-assistant-tables-prod-connections`, `coach-assistant-tables-prod-conversations`,
  `fixture-hosts-dev`, `fixture-test-runs-dev`, `llm-insights-prod`, `media-operations-dev`,
  `media-operations-prod`, `saga-admin-changelog-dev`, `saga-image-service-state-prod`.

**Consequence:** prod has no ledger footprint anywhere. `ss env list` needs a graceful
"not ledger-tracked" path — an explicit line, not an error and not a blank that reads as
"zero resources". The dev-platform ledger is a *dev-platform* construct; prod is simply not one of
its environments.

## Q2 — Live prod ECS cluster names. **`prod-shared`, and there is no arm cluster.**

`ecs list-clusters` (26 clusters; the shared-mesh-relevant ones):

| Cluster | Relevance |
|---|---|
| `prod-shared` | **The shared mesh cluster** — the prod analogue of `dev-shared` |
| `prod-apis` | Legacy/separate; **not** the shared mesh |
| `recorder_cluster_prod`, `av-recorder-cluster-prod-v3`, `media_postprocessing_prod` | Recording/AV fleets, out of scope for `ss env` |

There is **no `prod-shared-arm`**. The asymmetry the issue spotted in
`cloudformation_templates/ecs/cluster/samconfig.yaml` is real: dev runs both `dev-shared-arm` and
`dev-shared` (arm carrying most of the mesh), prod runs a single `prod-shared`.

**Consequence:** prod's per-env `ecsClusters` is `['prod-shared']` — a one-element list, which the
existing loop-over-clusters code in `connect.ts:183` and `verify.ts:142` handles unchanged.

## Q3 — Prod SSM jump host EC2 Name tag. **`prod-shared-ecs-instance` — confirmed.**

`ec2 describe-instances` filtered to `instance-state-name=running` shows **four** instances tagged
`Name=prod-shared-ecs-instance`:

```
i-073fc647412824223  i-0a925a057ba47855b  i-084e5222592622fb3  i-0a89717815c90ec15
```

Symmetry with `dev-shared-ecs-instance` held. The same "shared ECS instances double as the SSM jump
host" pattern applies.

> Not yet checked: whether these report `Online` in SSM. `resolveJumpHost` filters on
> running **+ Online**, so Phase 1 should confirm at least one is Online before relying on it.

## Q4 — db-host-v2 in prod, or RDS? **RDS. There is no db-host-v2 in prod.** ⚠️ *material*

`servicediscovery list-namespaces`, DNS_PRIVATE only:

| Account | DNS_PRIVATE namespaces |
|---|---|
| dev `396913734878` | `dbs`, **`dbs-v2.local`** |
| prod `531314149529` | `dbs.internal`, `db_temp` — **no `dbs-v2.local`** |

And `ssm describe-parameters` under `/shared/infra/prod` returns the RDS parameter shape:

```
/shared/infra/prod/postgres-endpoint
/shared/infra/prod/postgres-port
/shared/infra/prod/postgres-resource-id
/shared/infra/prod/postgres-master-secret-arn
/shared/infra/prod/postgres-sg-id
```

(The same root also carries `mongodb-hosts`, `mongodb-replica-set-name`, `redis-endpoint`,
`rabbitmq-broker-id`, `internal-services-alb-*`, `vpc-id`, `private-subnet-ids`, and
`private-dns-namespace-id` — a complete shared-infra discovery root, so `ss env discover --env prod`
has plenty to find.)

**Consequence — this changes `connect`'s design.** The CloudMap dance
(`discover-instances` → the container's own host instance + port → SSM to *that* instance with a
`127.0.0.1` dial) exists solely because dev's shared jump host SG cannot reach per-service DB
*containers*. **An RDS endpoint has no such constraint.** Prod `connect` is the *simpler* path: SSM
port-forward from the jump host straight to the RDS endpoint. Prod is not a port of the dev path —
it is a second, shorter one.

## Q5 — Floor credential tier for prod `connect`. **Unresolved — a policy decision.**

Discovery cannot answer this. Known prod profiles from `~/.aws/config`: `prod_admin`
(AdministratorAccess), `saga-runtime-prod` (AppRuntime), `saga` (Observer).

The proposal on the table (see `../source/plan.md`, Phase 2): read-only commands accept Observer;
`connect` requires an explicitly prod-capable profile and refuses Observer with an actionable
message; `--print-only` becomes the documented default habit for prod.

---

## Still unverified

Two prod reads were blocked by the session's permission classifier and remain open. Both are
one-command confirmations that Phase 1 should run first:

1. **The `postgres-endpoint` parameter value.**
   `aws ssm get-parameter --name /shared/infra/prod/postgres-endpoint --profile prod_admin`
   The RDS conclusion in Q4 rests on parameter *shape* plus the absence of `dbs-v2.local` — strong,
   but not yet a read of the endpoint itself.
2. **ECS service names on `prod-shared`.**
   `aws ecs list-services --cluster prod-shared --profile prod_admin`
   `verify --ecs` builds service names as `${ecsService}-${env.ledgerIdentifier}`; whether prod
   follows that suffix convention is unknown, and guessing it would silently skip the platform check.

Also unconfirmed: the prod ALB host-header rules that `verify`'s per-service host map must be built
from. Prod serves `my.saga.org` / `my.sagaeducation.org` rather than a single wildcard apex, so that
map cannot be derived — it has to be read off the listener rules and confirmed by live body check,
exactly as dev's was.
