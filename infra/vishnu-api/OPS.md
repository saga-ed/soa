# Vishnu dev deployment preparation

These templates are prepared and locally validated; they have not been deployed.
No DNS record, target group, ECS service, image push or live ALB rule was created.
The dedicated dev Datadog application-key secret exists. Production is out of scope.

## Design and verified prerequisites

The frontend and SOA/tRPC backend share an ARM64 Node container on
`dev-shared-arm`, with private tasks and inbound traffic only from the shared ALB.
JANUS guards both UI and API; allowed permissions match staff-admin-console:
`iam-admin`, `staff:super_admin`, `staff:support`, or `staff:org_admin`.

On 2026-10-23, read-only checks verified the dev cluster/capacity provider, VPC,
private subnets, ALB security group/listener, and `*.wootops.org` TLS certificate.
JANUS accepted `https://vishnu.wootops.org/` as the post-login return URL and
redirected to JumpCloud. JWKS was reachable. An actual staff login through the
new deployed hostname still needs testing after DNS and routing exist.

Staff-admin-console currently uses Amplify + Lambda and retains ALB OIDC rules.
Vishnu uses a long-running container to accommodate its eventual MQ receiver;
new routing follows the canonical JANUS perimeter rather than copying that
existing edge-OIDC exception. Confirm the shared ALB WAF policy at launch: both Observer and AppInfra lack
`wafv2:GetWebACLForResource`, so its attachment could not be verified here.

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
   because other services can claim priorities. Prepare green standing routing
   before introducing blue/green cutovers; only initial blue is configured here.

3. Build and push a commit-tagged ARM64 image to
   `396913734878.dkr.ecr.us-west-2.amazonaws.com/soa/vishnu-api:<git-sha>` after ECR
   exists. CodeArtifact authentication uses a BuildKit secret:

   ```sh
   docker build --platform linux/arm64 --secret id=npmrc,src="$HOME/.npmrc" \
     -f apps/node/vishnu-api/Dockerfile -t <dev-image-uri> .
   ```

   Use a current CodeArtifact token and ECR login. Never use build arguments for
   credentials. The runtime is non-root and carries only deployed dependencies,
   built backend and static frontend.

4. Render the full service command with
   `python3 infra/vishnu-api/render-deploy-command.py dev ImageArn=<dev-image-uri> BuildRevision=<git-sha>`.
   Review and run it; wait for healthy targets and verify build identity.
   The image and task definition both use ARM64. Desired count is one.
   Test the blue header rule before exposing the live hostname.

5. Create the dev live weighted rule through the current Saga blue/green tooling
   (inspect installed `create-rule --help` first), initially routing to blue.
   The live rule must stay outside CloudFormation. Add a Route53 alias for
   `vishnu.wootops.org` in zone `Z07700453LJ7LUSAA9XZ6` pointing to the shared dev
   ALB; inspect its current DNS name and canonical hosted-zone ID rather than
   copying stale values. There was no Vishnu record at preparation time.

6. Verify public health/build identity; unauthenticated UI redirects to JANUS;
   JSON/tRPC returns 401; nonstaff sessions return 403; a real staff session loads
   live dev statistics and Datadog links. Confirm no prod observations appear in
   dev scope and no credentials reach browser responses. Check task logs and the
   image's deployed revision. Check expired-session reauthentication.

## Boundaries and remaining work

This is a manual dev bring-up package. No GitHub deploy role/workflow has been
created; do not attach the reduced service template to the generic ECS workflow
without adding its required parameter contract and caller configuration. The existing event-statistics CI job also builds and tests the hosted backend
and signed-session browser flow on Node 24; it performs no deployment. No production samconfig or credentials are provided.

The first cloud view is explicitly environment-wide because measured trace
series lack deployment tags. Cloud MQ is off: deploy durable receiver storage,
broker credentials/connectivity and producer/consumer adoption before enabling
it. Environment-wide MQ aggregation needs its own scope design; current receiver
configuration requires an exact deployment. Synthetic slot 3 remains independent.

For an initial failed launch, keep DNS/live routing absent and inspect the failed
task/logs. Once serving, redeploy the previous immutable image tag for rollback;
introduce the green lane before using colour flips. Retained ECR/log resources
can survive bootstrap rollback: inspect ownership before retrying. Do not delete
shared infrastructure to recover this service.
