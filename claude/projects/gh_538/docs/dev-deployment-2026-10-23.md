# Vishnu dev deployment evidence

Deployed 2026-10-23 under the user’s instruction to start the dev runbook.
Public URL: https://vishnu.wootops.org. No production resources were changed.

## Runtime and infrastructure

- Account `396913734878`, region `us-west-2`, ECS cluster `dev-shared-arm`.
- AppInfra created Vishnu resources; PlatformInfra created the Route53 alias.
- Bootstrap, blue/green routing and blue/green service stacks: `CREATE_COMPLETE`.
- Live priority 4015: blue 100, green 0. Preview priorities 2 and 18 use
  `x-saga-preview-vishnu-api: blue|green`.
- Blue desired/running count 1/1, one healthy ALB target; green 0/0.
- ECR image `soa/vishnu-api:9c4b699a`, ARM64, digest
  `sha256:0e7bbb1025d90eb89a00ec33a736eb05142df5b84445b4c384b511a2bfb4435b`.
- `/health` reports colour blue, environment dev, version
  `9c4b699a56debd3c6d0ffffb837649aca687ff50`.
  Later commit `44913574` adds CI checks; the deployed runtime is unchanged.
- DNS alias change `/change/C05870982HOIEV7L50F1V` is INSYNC.
- `saga-waf-dev` reports `WebAclAssociation` UPDATE_COMPLETE for the dev ALB.
  Direct WAF reads are denied to the available non-admin profiles.

## Acceptance evidence

All PR CI checks passed before deployment, including hosted authentication and
browser tests. The exact ARM64 runtime image passed non-root startup and
unauthenticated boundary checks locally before ECR push.

Through the dev ALB preview header: `/health/ready` returned 200; `/api/mesh`,
`/trpc/telemetry.mesh` and `/config.json` returned 401 without a session; `/`
returned 302 to JANUS. Public DNS `/health` returned the expected build identity.
The Saga blue/green readout confirms healthy blue and a single serving colour.

Browser navigation completed JumpCloud verification and loaded the protected UI.
The page showed `Datadog: connected · dev / all`, 19 observed/declared systems and
four observed paths at verification time. The Programs API inspector displayed
0.8 requests/sec and a 1,322 ms p95 bucket, dev monitor links, and an
`env:"dev" service:"programs-api"` trace link. Values and observed edges vary with
the rolling window; absent or expired samples remain unknown. Cloud MQ is disabled
as planned; the synthetic slot-3 receiver remains separate. No authentication
bypass or fabricated cloud observations were introduced.

The local Saga blue/green CLI was invoked from `/home/skelly/dev/iac/saga-platform`
after inspecting its help/source; the bundled wheel predates this command.
Its generic takeover warning included our two header-gated preview rules. They
remain intentionally installed; the live rule does not replace them.
