# soa GitHub Actions OIDC roles

Deploy roles for soa live here, with the code they deploy. The account's OIDC provider is shared: this stack trusts it by ARN and never creates one.

| Role | AWS account | Stack | GitHub variable | Scope |
|------|-------------|-------|-----------------|-------|
| CI | Prod (531) | not in this repo | `AWS_ROLE_ARN` (repo-level) | CodeArtifact tokens for CI and for the Vishnu image build |
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

Add no required reviewers to `dev`. The preflight, build and deploy jobs bind to it, so a reviewer would pause every dispatch three times. If dispatches ever need an approval, add it deliberately and expect that.

The test job doesn't bind to `dev`. It runs dependency install scripts and tests, and binding it would let that code request a token this role trusts. It still gets its CodeArtifact token from `AWS_ROLE_ARN`, which is a repository variable.

## Trust

The role trusts one subject: `repo:saga-ed/soa:environment:dev`. soa is public, so a job has to bind the `dev` environment to assume it. `pull_request`, branch and tag subjects are not trusted.

## Scope

The grants follow what `.github/workflows/deploy-vishnu-api.yml` and `.github/scripts/vishnu-deploy.sh` do:

| Grant | Used by |
|-------|---------|
| ECR push, pull and `DescribeImages` on `soa/vishnu-api` | the build job and its skip-if-built check |
| Change sets on `soa-vishnu-api-blue` and `-green` | `sam deploy`, and the scope check in the guard |
| SSM read on `/soa/vishnu-api/infra/dev/*` and the cluster and subnet parameters | CloudFormation resolving the template's parameters as this role |
| ECS task definitions, and the two colour services | the service stack; the actions follow the `AWS::ECS::Service` and `AWS::ECS::TaskDefinition` registry handlers |
| ELB describe on load balancers, listeners and rules | the live colour guard; nothing is written |
| `PassRole` on the two Vishnu task roles, to `ecs-tasks` only | the task definition |

Left out on purpose:

- **Routing, bootstrap and the live rule.** These stay manual, as `infra/vishnu-api/OPS.md` describes. The role can't change a target group or listener rule, so it can't flip live traffic.
- **CodeArtifact.** The workflow gets its token with `AWS_ROLE_ARN`, the same role soa's other workflows use, so this role needs no cross-account access.
- **The SAM bucket.** `infra/vishnu-api/samconfig.yaml` sets none, and the template is small enough to send inline.
- **WAF bypass and any other secret.** The health check is a plain `GET /health`; see `infra/vishnu-api/OPS.md`.
- **`ecs:RunTask`.** The workflow runs no migrations.
- **Application Auto Scaling.** The service template registers no scalable target.
- **Sandbox and preview grants.** See I#561.

`ecs:RegisterTaskDefinition` stays on `*`, as it does in program-hub. PassRole is what limits the task definitions this role can use.
