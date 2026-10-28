# Hosted observation runtime

Date: 2026-10-23. User requested autonomous dev deployment preparation and reuse
of the SOA tRPC application patterns. Production deployment is excluded.

Use one long-running Node/ExpressServer container for the static SvelteKit
frontend and read-only tRPC router. This retains the established SOA DI/health
conventions and supports a future persistent MQ receiver. staff-admin-console's
Amplify/Lambda split is unsuitable for that receiver, although its JANUS staff
permission policy is reused. Its live ALB OIDC rules remain an existing exception;
new Vishnu routing uses JANUS in the app with the shared ALB perimeter.

The public dev origin is `https://vishnu.wootops.org`. The shared ALB already has
an issued wildcard certificate; JANUS accepts this return URL and serves JWKS.
No Vishnu DNS/routing/service deployment has occurred. A real staff login on the
new origin is a post-deploy acceptance check. Local tests use genuinely signed
EdDSA sessions with test JWKS, not an authentication bypass.

Datadog metrics, dependency and monitor reads succeeded with a dedicated scoped
application key stored in dev Secrets Manager. Live trace series in both dev and
prod lack `deployment.identifier`, so cloud observation uses an explicit
**environment** scope. Deployment-scoped reads never broaden automatically.
Synthetic slot scope remains independent. Saga Dash's observed APM service ID is
`saga_dash`. Missing measurements remain unknown; adjacency does not prove HTTP,
edge traffic or latency. Composite monitor inputs (including traffic guards)
are evidence, not independent critical alerts.

This first hosted configuration disables MQ. Durable receiver storage and
service adoption still need cloud deployment, and environment-wide MQ requires
an explicit aggregation/scope design. The existing exact-deployment receiver and
synthetic tests are retained. The application key is currently user-owned;
service-account ownership can be addressed separately without blocking dev.

See [runtime documentation](../../../../apps/node/vishnu-api/README.md) and
[operations guide](../../../../infra/vishnu-api/OPS.md) for configuration and the
manual bring-up sequence. The guide distinguishes verified prerequisites from
remaining launch work; no production or automatic deploy workflow was generated.
