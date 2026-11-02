# What ci-actions `deploy-ecs-api` expects vs what Vishnu has

Measured 2026-10-30 against soa `origin/main`, ci-actions v2.50 (WF = `.github/workflows/deploy-ecs-api.yml`, ACT = `deploy-ecs-api/action.yml`), program-hub, rostering and iac. Rechecked on 2026-11-02 against soa `c32dd0ee`: no Vishnu infra changes on main, and ci-actions is now at v2.51 (not re-read).

Confirmed directly: the undeclared template parameters, `IMMUTABLE` dev ECR, `id=npmrc` vs `codeartifact=`. The rest is from one research pass over the sources cited; recheck line numbers when implementing.

## What the workflow sends the service stack

- Always `Identifier`, `ImageArn`, `DeploymentDatetime`, `TtlDays` (ACT:947-950), then the caller's JSON.
- `ClusterArnSSMParameter`, `CapacityProviderName`, `CpuArchitecture`, unless the caller passed that key (ACT:998-1000).
- `TargetGroupArnSSMParameter=/${project}/infra/${env}/${scope}${id}/target-group-arn`, unless the caller passed it or external routing is on (ACT:1016).
- Stack name `${project}-${service}-${identifier}`, run with `--config-env $ENVIRONMENT` (ACT:1030-1046). For Vishnu that is `soa-vishnu-api-blue`, which already matches.

**CI's `--parameter-overrides` replaces samconfig's list wholesale** (caller-contract.md:169-180). `OPS.md` warns of the same trap for manual deploys.

Caller permissions: `id-token: write`, `contents: write`, `pull-requests: write`, `actions: read`, `deployments: write`; `secrets: inherit` for Slack webhooks.

## Gaps

| Gap | Evidence | Fix |
|---|---|---|
| BuildKit secret name | Dockerfile:7 requires `id=npmrc`; WF:2203 passes `codeartifact=` | Fleet pattern: program-hub `apps/node/programs-api/Dockerfile:24-34` |
| Undeclared parameters | `service-template.yaml` lacks `DeploymentDatetime`, `TtlDays`, `CpuArchitecture`; CloudFormation rejects unknown parameters | Declare them; use `CpuArchitecture` at line 47 |
| `BuildRevision` | Line 7 has no default and the workflow doesn't send it | Caller passes `${{ github.sha }}` |
| samconfig is ignored | `dev` and `dev-green` values dropped; `ExecEnv` and capacity provider default to prod | Caller JSON enumerates every value, as in `deploy-programs-api.yml:396` |
| Target-group path | Workflow default `/soa/infra/dev/<id>/…`; Vishnu writes `/soa/vishnu-api/infra/dev/<id>/…` | Pass explicitly |
| Routing | No `routing` config-env; template uses `ListenerRulePriorityBase` | `use-external-routing: 'true'`; colour routing stacks stay manual |
| ECR URI | Bootstrap writes no ECR SSM parameter | Add one for `ecr-ssm-name` |
| Immutable ECR | `bootstrap-template.yaml:80`; both build paths reportedly overwrite `buildcache-dev*` (WF:2210-2213, ACT:425-426). A direct grep for `buildcache-dev` in WF at v2.50 returned no match, so **recheck the tag name** | Mutable dev, or exempt the prefix |
| Health check | Without a header, the probe hits the live rule and false-passes (`deploy-programs-api.yml:90-93`) | `preview-header: <colour>` |
| SPA not covered | CI runs turbo with one `pnpm-filter`; the SPA isn't a dependency of the API. `vishnu-api` also has no `lint` script | *(open)* filter expression or wrapper package |

## Already compatible

Secret ARNs resolved by ECS; dev ARM cluster and capacity-provider defaults; stack names; the `dev` config-env; `bluegreen-services.json` already lists `vishnu-api`; `/health` is unauthenticated.

`service-template.yaml` is shared in name only: it hardcodes Vishnu's family, port and env vars.

## Deploy role

soa has only `SOADeployRole` in the prod account (CodeArtifact), trusting `repo:saga-ed/soa:*`. It can serve as `ci-role-arn`. A dev-account (396913734878) deploy role is missing, and by convention lives with the code (`references/iam-roles.md`). It should trust the shared OIDC provider by ARN.

Scope: CodeArtifact read; ECR push on `soa/*`; CloudFormation on `soa-vishnu-api-*`; ECS task definition and service; autoscaling describe; ELB on a `vishnu*` prefix; SSM read on `/soa/*`, `/shared/infra/dev/*`, `/dev/shared-arm/*`; SSM write on `/soa/vishnu-api/infra/dev/*`; `PassRole` on the two Vishnu task roles.

*(open)* Whether the CodeArtifact domain policy already admits a new dev-account role.

## Sandbox flow, for I#561

program-hub `sandbox-deploy.yml` is dispatched by switchboard's sandbox-api, `saga-sandbox create` or patch-party. It uses `identifier=sandbox-<name>`, `use-saga-deploy-routing: true` (per-sandbox target group and rule from `saga-init.yaml`), header `x-saga-preview-<svc>`, and a terminal callback. Health check is skipped for `sandbox-*` (WF:2805), and variants register in switchboard (WF:3122-3125). Patch-party lists soa as having no `sandbox-deploy.yml`.

*(open)* Switchboard catalog entry; browser delivery of the preview header to a header-routed SPA; JANUS return URL in a sandbox.
