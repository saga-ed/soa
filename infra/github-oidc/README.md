# soa GitHub Actions OIDC roles

Deploy roles for soa live here, with the code they deploy. The account's OIDC provider is shared: this stack trusts it by ARN and never creates one.

| Role | AWS account | Stack | GitHub variable | Scope |
|------|-------------|-------|-----------------|-------|
| CI | Prod (531) | not in this repo | `AWS_ROLE_ARN` (repo-level) | CodeArtifact read, for the `ci` job |
| Dev deploy | Dev (396) | `soa-github-oidc-dev-deploy` | `SOA_DEPLOY_ROLE_ARN` (`dev` environment) | Vishnu blue/green colour deploys only |

## Deploy the dev deploy role

A human does this once, and again after any change to the template. It writes IAM in the dev account, so it needs the AppInfra tier. Run it from the repo root, and review the change set when prompted:

```bash
aws sso login --profile saga-infra-dev

sam deploy \
  --profile saga-infra-dev \
  --region us-west-2 \
  --template-file infra/github-oidc/dev-deploy-role-template.yaml \
  --stack-name soa-github-oidc-dev-deploy \
  --capabilities CAPABILITY_NAMED_IAM \
  --confirm-changeset
```

When changing an existing role, run `/saga-iac:iam-diff` first to see which grants the change set alters.

## Wire up GitHub

Do this after the stack exists. Both commands are idempotent:

```bash
gh api -X PUT repos/saga-ed/soa/environments/dev

gh variable set SOA_DEPLOY_ROLE_ARN \
  --repo saga-ed/soa \
  --env dev \
  --body 'arn:aws:iam::396913734878:role/github-actions-role/SoaGithubActionDevDeployRole'
```

Add no required reviewers to `dev`. `build-and-deploy` binds to it, so a reviewer would pause every dispatch.

`SOA_DEPLOY_ROLE_ARN` is environment-scoped, and a `uses:` job can't declare `environment:`. The caller therefore reads it in a small job bound to `dev` and passes it on as a job output, as program-hub's `deploy-programs-api.yml` does in its `config` job.

## Trust

The role trusts two subjects in `saga-ed/soa`:

- `environment:dev`, for the jobs bound to the `dev` environment (`ci` and `build-and-deploy` in `deploy-ecs-api.yml`, and the caller's config job).
- `ref:refs/heads/*`, for the jobs `deploy-ecs-api.yml` leaves unbound on dev (`build-image`, `merge-image`, `wait-stable`, `register-switchboard`). These present the branch subject, so a trust limited to `environment:dev` would fail the build. Any branch is allowed because a dispatch can run from any branch.

`pull_request` and tag subjects are not trusted. PR previews would have to add them, along with the other grants they need.

## Scope

The grants follow what `deploy-ecs-api.yml` and `deploy-ecs-api/action.yml` do for a colour deploy with `use-external-routing` and `native-multiarch-build`:

| Grant | Used by |
|-------|---------|
| ECR push and pull on `soa/vishnu-api` | `build-image`, `merge-image`, image checks |
| CodeArtifact token and read on `saga_js`, `saga_py` | image build, `saga-platform` CLIs |
| Change sets on `soa-vishnu-api-blue` and `-green` | `sam deploy`, and the scope check in the caller's config job |
| SSM read on `/soa/vishnu-api/infra/dev/*` and the cluster and subnet parameters | ECR URI, and CloudFormation resolving the template's parameters |
| ECS task definitions, and the two colour services | the service stack, `wait-stable` |
| ELB describe on load balancers, listeners and rules | `resolve-active-colour` in the caller's config job; nothing is written |
| `GetSecretValue` on the switchboard key and WAF bypass token | `register-switchboard` |
| `PassRole` on the two Vishnu task roles, to `ecs-tasks` only | the task definition |

Left out on purpose:

- **Routing, bootstrap and the live rule.** These stay manual, as `infra/vishnu-api/OPS.md` describes. The role can't change a target group or listener rule, so it can't flip live traffic.
- **The SAM bucket.** `infra/vishnu-api/samconfig.yaml` sets none, and the template is small enough to send inline.
- **Lambda invoke.** The ledger steps skip `blue` and `green`.
- **`ecs:RunTask`.** The workflow doesn't enable migrations.
- **Application Auto Scaling.** The workflow doesn't set `wake-before-deploy`, and the service template registers no scalable target. Turning wake on needs `DescribeScalableTargets`.
- **Sandbox and preview grants.** See I#561.

`ecs:RegisterTaskDefinition` stays on `*`, as it does in program-hub. PassRole is what limits the task definitions this role can use.
