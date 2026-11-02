# Vishnu dev deployment operations

Dev was first deployed on 2026-10-23 at https://vishnu.wootops.org; all five stacks
completed successfully. Production is out of scope. See
[deployment evidence](../../claude/projects/gh_538/docs/dev-deployment-2026-10-23.md).

The live colour changes with each flip, so read it rather than trusting a document.
Live rule 4015 (`vishnu.wootops.org`) forwards to the target group with non-zero weight:

```sh
aws elbv2 describe-rules --profile saga-infra-dev --region us-west-2 \
  --listener-arn "$(aws ssm get-parameter --profile saga-infra-dev --region us-west-2 \
    --name /shared/infra/dev/app-alb-443-listener-arn --query Parameter.Value --output text)" \
  --query "Rules[?Priority=='4015'].Actions[0].ForwardConfig.TargetGroups"
```

Read on 2026-11-02: green 100, blue 0, with both colour stacks at `DesiredCount=1`.

## Design and verified prerequisites

The frontend and SOA/tRPC backend share an ARM64 Node container on
`dev-shared-arm`, with private tasks and inbound traffic only from the shared ALB.
JANUS guards both UI and API; allowed permissions match staff-admin-console:
`iam-admin`, `staff:super_admin`, `staff:support`, or `staff:org_admin`.

On 2026-10-23, read-only checks verified the dev cluster/capacity provider, VPC,
private subnets, ALB security group/listener, and `*.wootops.org` TLS certificate.
JANUS accepted `https://vishnu.wootops.org/` as the post-login return URL and
redirected to JumpCloud. JWKS was reachable. A real staff login through the deployed hostname was subsequently verified,
including connected dev Datadog statistics in the inspector.

Staff-admin-console currently uses Amplify + Lambda and retains ALB OIDC rules.
Vishnu uses a long-running container to accommodate its eventual MQ receiver;
new routing follows the canonical JANUS perimeter rather than copying that
existing edge-OIDC exception. The `saga-waf-dev` CloudFormation stack reports a completed WebACL association
with this dev ALB. Direct WAF inspection is denied under Observer, AppInfra and
PlatformInfra; attachment evidence comes from CloudFormation resource metadata.

Datadog API metrics, service dependencies and monitors returned HTTP 200 with the
new `vishnu-readonly` application key. Its scopes are `apm_read`,
`timeseries_query`, and `monitors_read`; Actions API access is disabled.
It is currently Sean Kelly-owned, not service-account-owned. No key values belong
in git, command arguments, frontend bundles or logs. Deployment configuration
contains secret ARNs only; ECS resolves them through its execution role.

## Bring-up order

Run from the repository root with current SSO credentials for `saga-infra-dev`.
The renderer requires Python/PyYAML (available with SAM), prints commands only,
and carries forward **all** configured parameters. Supplying SAM
`--parameter-overrides` directly replaces the entire samconfig parameter list.
Do not append just an image or priority override to an otherwise configured SAM
command.

1. Recheck account `396913734878`, region `us-west-2`, secret metadata and the SSM
   paths in `samconfig.yaml`. Do not print secret values. Validate templates:

   ```sh
   sam validate --lint --template-file infra/vishnu-api/bootstrap-template.yaml
   sam validate --lint --template-file infra/shared/routing-template.yaml
   sam validate --lint --template-file infra/shared/service-template.yaml
   python3 infra/vishnu-api/render-deploy-command.py bootstrap-dev
   ```

   Review and run the emitted bootstrap command. It creates ECR, logs, task roles,
   task security group and scoped SSM outputs; IAM roles use `SagaProdMax`.

2. Read the current ALB listener rules and choose an unused priority in the Saga
   colour-preview range. Render routing with
   `python3 infra/vishnu-api/render-deploy-command.py routing-dev-blue ListenerRulePriorityBase=<verified-priority>`.
   Review and run it. This creates the blue target group and header-gated rule,
   **not** the live weighted rule. Repeat this check immediately before deploying
   because other services can claim priorities. Green uses `routing-dev-green` with its own verified priority. Both routing
   stacks now exist; registry priorities are blue=2, green=18, live=4015.
   The live-rule CLI warns about these CFN-owned preview rules as possible
   takeovers. They are header-gated and intentionally precede the live rule:
   retain both routing stacks; do not follow the generic warning to retire them.

3. Complete the one-time CI prerequisites below, once.

4. Dispatch the build and deploy of the idle colour, from any branch once the
   workflow is on main:

   ```sh
   gh workflow run deploy-vishnu-api.yml -R saga-ed/soa --ref <branch> -f colour=<idle-colour>
   ```

   `.github/workflows/deploy-vishnu-api.yml` runs check-types, lint and test, builds
   the ARM64 image on a native ARM runner, tags it `<git-sha>`, deploys
   `soa-vishnu-api-<colour>` with `DesiredCount=1` and probes `/health` through
   `x-saga-preview-vishnu-api: <colour>`. Live traffic does not move. The workflow
   reads rule 4015 first and refuses the colour that is serving; it fails closed if the
   rule is missing, split or all zero. That guard holds only for a fresh dispatch or
   "Re-run all jobs". Never use "Re-run failed jobs" on this workflow: it keeps the
   first attempt's result, so it replaces the live tasks if that colour was flipped live
   since. Dispatch again instead.
   Do not flip while a run is in progress: the check runs only at the start.
   Test the colour through the header rule before flipping.

   To redeploy the colour that is serving, deploy the idle colour and flip. The
   workflow has no override for this.

   On a from-scratch bring-up the first colour can't use CI: the guard needs the rule
   that step 5 creates, and step 5 routes to blue. Deploy blue with the
   [break-glass build](#break-glass-local-build), do step 5, then dispatch green and
   every later deploy.

5. Create the dev live weighted rule through the current Saga blue/green tooling
   (inspect installed `create-rule --help` first), initially routing to blue.
   The live rule must stay outside CloudFormation. Add a Route53 alias for
   `vishnu.wootops.org` in zone `Z07700453LJ7LUSAA9XZ6` pointing to the shared dev
   ALB; inspect its current DNS name and canonical hosted-zone ID rather than
   copying stale values. The dev alias now exists; inspect it before making any future DNS change.

6. Verify public health/build identity; unauthenticated UI redirects to JANUS;
   JSON/tRPC returns 401; nonstaff sessions return 403; a real staff session loads
   live dev statistics and Datadog links. Confirm no prod observations appear in
   dev scope and no credentials reach browser responses. Check task logs and the
   image's deployed revision. Check expired-session reauthentication.

## One-time CI prerequisites

Run once, with `saga-infra-dev`, before the first dispatch. The workflow must already
be on main for `gh workflow run` to find it.

1. Deploy the role stack from `infra/github-oidc/dev-deploy-role-template.yaml`. It
   creates `/github-actions-role/SoaGithubActionDevDeployRole` with the
   `SagaGithubActionsMax` boundary.
2. Update the bootstrap with `python3 infra/vishnu-api/render-deploy-command.py bootstrap-dev`
   and review the change set. It should only make the dev ECR repository mutable
   (CI overwrites `buildcache-*`) and add `/soa/vishnu-api/infra/dev/ecr-repo-uri`.
   Parameters the renderer omits keep their previous values.
3. Create the GitHub environment and its variable:

   ```sh
   gh api -X PUT repos/saga-ed/soa/environments/dev
   gh variable set SOA_DEPLOY_ROLE_ARN -R saga-ed/soa --env dev \
     --body arn:aws:iam::396913734878:role/github-actions-role/SoaGithubActionDevDeployRole
   ```

4. [Return the idle colour to `main` scope](#returning-a-colour-to-main-scope) if it isn't
   there, or the dispatch refuses it. Read on 2026-11-02: blue (idle) has
   `EventStatsDeployment=sandbox-gh537`; green is at `main`.

The CI job uses the existing repository variable `AWS_ROLE_ARN`.

## Observing a sandbox from CI

Add `-f preview-tag=sandbox-<name>` to the dispatch to send `EventStatsPreviewTag` and
`EventStatsDeployment`. The run refuses this unless the dispatched ref's template declares
`EventStatsPreviewTag` (PR#556) and that colour's stack has `VishnuMqEnabled=true`. SAM
silently drops a parameter the template doesn't declare, so without the check the colour would
take the sandbox's queue and store scope but no sandbox bindings, and `/health` would still pass.

An empty `preview-tag` does not clear an earlier one. SAM reuses the previous value of
any parameter it isn't sent, and the workflow can't send an empty value, so the run refuses a
colour whose `EventStatsDeployment` isn't `main`. Pass the tag again to keep observing, or
return the colour to `main` scope.

### Returning a colour to `main` scope

Reset the idle colour only, and keep its current image so that only the scope changes. Read
the image and revision, then render the command, here for blue:

```sh
aws cloudformation describe-stacks --profile saga-infra-dev --region us-west-2 \
  --stack-name soa-vishnu-api-blue \
  --query "Stacks[0].Parameters[?ParameterKey=='ImageArn' || ParameterKey=='BuildRevision']" --output table
python3 infra/vishnu-api/render-deploy-command.py dev ImageArn=<image> BuildRevision=<sha> EventStatsDeployment=main
```

For green, render `dev-green` and add `DesiredCount=1`: samconfig sets it to 0, so leaving it out
scales green to zero.

If the checked-out template declares `EventStatsPreviewTag`, append this to the printed command,
single quotes included:

```sh
'EventStatsPreviewTag=""'
```

The renderer refuses empty values, so this has to be added by hand. Without the single quotes the
shell strips the double quotes and SAM rejects `EventStatsPreviewTag=`. Review the change set
before executing it.

## Break-glass local build

If CI is down, a local build still works, and on x86 it runs under QEMU for minutes of
heavy CPU. Use a current CodeArtifact token and ECR login, and never pass credentials as
build arguments. The token goes in as the `codeartifact` BuildKit secret:

```sh
export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token --profile <profile> \
  --domain saga --domain-owner 531314149529 --query authorizationToken --output text)"
docker build --platform linux/arm64 --secret id=codeartifact,env=CODEARTIFACT_AUTH_TOKEN \
  -f apps/node/vishnu-api/Dockerfile -t <dev-image-uri> .
```

Push it, then render and review the service command:
`python3 infra/vishnu-api/render-deploy-command.py dev ImageArn=<dev-image-uri> BuildRevision=<git-sha>`
(`dev-green` for green, which also needs `DesiredCount=1`, because samconfig sets it to 0).

## Boundaries and remaining work

The build and service deploy of a dev colour run from
`.github/workflows/deploy-vishnu-api.yml`. Bootstrap, the routing stacks, the deploy role
stack, DNS and the live rule stay manual. There is no push trigger, per-sandbox or
PR-preview deploy (I#561, deferred). The existing event-statistics CI job also builds and tests the hosted backend
and signed-session browser flow on Node 24; it performs no deployment. No production samconfig or credentials are provided.

The first cloud view is explicitly environment-wide because measured trace
series lack deployment tags. Cloud MQ is off until the receiver steps below run.
Per gh_536 d3, Datadog stays environment-wide while MQ uses its own exact scope
(`dev / main / shared-dev-mq / /`). Synthetic slot 3 remains independent.

## MQ receiver enablement (Gate D; approval required)

Decisions: `claude/projects/gh_536/decisions/d3`–`d5`. Reporters stay off
throughout (d7 enables them later, one service at a time).

1. Provision Vishnu's container Postgres through the db-host-v2 orchestrator
   (`db-orch-v2.wootdev.com`, see the saga-iac `db-host-v2.md` reference). Record
   the assigned host and **port** (one host port per container, usually not 5432).
2. Store the connection URL in Secrets Manager as `soa/vishnu/dev/database-url`.
   Never put the value in git, arguments or output.
3. Update the bootstrap with a reviewed change set:
   `render-deploy-command.py bootstrap-dev MqNetworkEnabled=true DbHostPostgresPort=<port> VishnuDatabaseUrlSecretArn=<arn>`.
   This adds broker (5671) and db-host ingress/egress plus execution-role read
   access to the database secret and `/shared/infra/dev/rabbitmq-url`.
4. Deploy the reviewed image to **green** with MQ on:
   `render-deploy-command.py dev-green ImageArn=<image> BuildRevision=<sha> DesiredCount=1 VishnuMqEnabled=true EventStatsBroker=shared-dev-mq VishnuDatabaseUrlSecretArn=<arn>`
   (`EventStatsDeployment` defaults to `main`, `EventStatsVhost` to `/`).
5. Validate through the `x-saga-preview-vishnu-api: green` header: JANUS login,
   table creation, queue `vishnu.main.event-stats.v1` bound only to
   `observability.event_stats.reported`, restart and redelivery, scope rejection,
   and that stopping green has no effect on business services.
6. Gate E: shift live rule 4015 to blue 0 / green 100. Blue stays available for
   rollback until the d7 soak ends. Both colours may consume the one queue (d4).

Rollback: shift 4015 back to blue, then redeploy green with `VishnuMqEnabled=false`
or `DesiredCount=0`. The queue is bounded (10,000 messages, 1h TTL), so reports
expire rather than build up.

For an initial failed launch, keep DNS/live routing absent and inspect the failed
task/logs. Once serving, redeploy the previous immutable image tag for rollback;
deploy and verify the idle green lane before using colour flips. Retained ECR/log resources
can survive bootstrap rollback: inspect ownership before retrying. Do not delete
shared infrastructure to recover this service.
