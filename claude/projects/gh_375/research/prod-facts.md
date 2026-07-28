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

## Q6 (not in the issue) — The prod apex and host shape. **Single-apex `saga.org`.** ⚠️ *refutes an issue premise*

The issue states prod "is not a single-apex fleet the way `wootdev.com` and `saga-training.org` are,
which affects how `verify` enumerates service hosts". **That is not what prod does.** Probed live
2026-07-28 over plain HTTPS, no AWS credentials involved:

| Host | Result |
|---|---|
| `iam.saga.org/health` | `{"status":"ok","service":"IAM API"}` |
| `sis.saga.org/health` | `{"status":"running","service":"SIS API","sisDb":"connected"}` |
| `programs-api.saga.org/health` | `{"status":"ok","service":"Programs API"}` |
| `scheduling-api.saga.org/health` | `{"status":"ok","service":"Scheduling API"}` |
| `sessions-api.saga.org/health` | `{"status":"ok","service":"Sessions API"}` |
| `dash.saga.org/` | HTML document |
| `coach.saga.org/` | HTML document |

That is **exactly** the dev `<host>.<domain>` convention with `domain: 'saga.org'`. `my.saga.org`
serves its own HTML app and is a *user-facing* SPA, not the API apex — which is what made the issue
read prod as multi-apex.

`sagaeducation.org` is **not a service apex at all**: `iam.sagaeducation.org`,
`coach-api.sagaeducation.org` and `ads-adm-api.sagaeducation.org` all NXDOMAIN. Treat it as an
apex-level alias, not something `verify` enumerates.

### Prod has no wildcard DNS — the dev false-green problem does not exist here

```
zzz-unrouted-test.wootdev.com/health          → 200, body `dev-account-alb`
definitely-not-a-real-service-xyz.saga.org    → NXDOMAIN (does not resolve)
```

Dev's wildcard DNS onto the shared ALB is the entire reason `classifyProbeBody` exists — a
status-code-only probe reports non-existent dev services as healthy. **Prod has no wildcard**, so an
unrouted prod host fails at DNS and surfaces as a transport error. Body judgment should stay (it is
still correct, and `HEALTHY_STATUSES` already covers prod's words — `sis` answers `running`, which is
allowlisted), but prod's failure mode is strictly *safer* than dev's, not more dangerous.

> Not established: what a host that *resolves* but is unrouted returns in prod. No such host was
> found, so `ALB_DEFAULT_MARKER` (`dev-account-alb`) has no confirmed prod analogue.

### Five services are absent at the dev-convention hostname

`content-api`, `ads-adm-api`, `coach-api`, `transcripts-api`, and `connectv3-api` **all NXDOMAIN**
under `saga.org` (and under `sagaeducation.org`). Note `coach.saga.org` (the web SPA) *does* serve —
so coach's frontend is in prod while `coach-api` is not reachable at the dev-convention name.

Do **not** conclude "not deployed to prod". Two readings fit — genuinely absent, or deployed under a
different prod hostname — and they need different handling. This is the one thing the prod ALB
host-header rules are still needed for:

```sh
LARN=$(aws ssm get-parameter --name /shared/infra/prod/app-alb-443-listener-arn \
  --profile prod_admin --region us-west-2 --query Parameter.Value --output text)
aws elbv2 describe-rules --listener-arn "$LARN" --profile prod_admin --region us-west-2 \
  --query 'Rules[].Conditions[?Field==`host-header`].Values[]' --output text
```

The `/shared/infra/prod/internal-services-alb-*` parameters hint at a public/internal ALB split, so
some of the five may be internal-only in prod — which would mean HTTP-unverifiable-by-design, not
unhealthy.

## Q5 — Floor credential tier for prod `connect`. **Decided: Observer reads, higher tier connects.**

Read-only commands (`list`, `discover`, `verify`) accept the Observer tier (`saga`). `connect` opens
a live tunnel to production tenant data and requires a prod-capable profile, refusing Observer with
an actionable message. `--print-only` is the documented default habit for prod.

Known prod profiles from `~/.aws/config`: `prod_admin` (AdministratorAccess), `saga-runtime-prod`
(AppRuntime), `saga` (Observer).

---

## Still unverified

1. **ECS service names on `prod-shared`** — the one hard blocker.
   `aws ecs list-services --cluster prod-shared --profile prod_admin`
   `verify --ecs` builds names as `${ecsService}-${env.ledgerIdentifier}`; whether prod follows that
   suffix convention decides a code branch, and guessing it would silently skip the platform check.
2. **Prod ALB host-header rules** — narrowed scope. No longer needed to build the whole host map
   (the `<host>.saga.org` convention supplies it); needed only to resolve the five absent services
   above.
3. **The `postgres-endpoint` parameter value** — *not* blocking. Endpoints are discovered at runtime
   and never hardcoded, so Phase 2's code does not embed it. Reading it would only raise confidence
   in the RDS inference, which already rests on parameter shape plus the absence of `dbs-v2.local`.
4. **Jump host SSM `Online` status** — *not* blocking. `resolveJumpHost` already treats "no running +
   Online instance" as an error path, so the code is the same either way.
