# @saga-ed/soa-deploy-color

Blue/green activity gate for the event plane (soa decision D13). Reads SSM `/prod/bluegreen/<svc>/active-color`
(`blue` | `green` | `none`, written by `saga-bluegreen flip`) and tells a task whether its colour should consume
RabbitMQ messages, relay the outbox, or run background jobs.

- Own colour: `deployment.identifier` in `OTEL_RESOURCE_ATTRIBUTES` (same source as `@saga-ed/soa-health`). Anything other than `blue`/`green` (`main`, absent) means the gate is always active.
- Fail-open: no `ACTIVE_COLOR_PARAM`, parameter absent, unrecognised value, boot read error or timeout => active (pre-D13 behaviour). Deleting the parameter reverts a service.
- Keep-last: a read error after a successful read holds the last value (`state().stale`), warning once per streak.
- `none` => inactive on both colours; `value !== own` => inactive.
- No AWS SDK dependency: inject `getParameter(name)`; map the SDK's `ParameterNotFound` through unchanged (`err.name`).

```ts
const gate = createActiveColorGate({
  getParameter: async (Name) => (await ssm.send(new GetParameterCommand({ Name }))).Parameter?.Value,
  logger,
}); // parameterName defaults to env.ACTIVE_COLOR_PARAM
await gate.start();                       // bounded boot read (3 s), then ~10 s jittered poll
gate.on('change', (active, value) => { /* pause or resume */ });
gate.isActive();
```

`EventConsumer` / `OutboxRelay` accept `Pick<ActiveColorGate, 'isActive' | 'on'>` structurally.
One-shot jobs use `resolveGate({ ownColor, parameterName, getParameter })`.

Task role grant (prod only): `ssm:GetParameter` on exactly `arn:aws:ssm:<region>:<acct>:parameter/prod/bluegreen/<svc>/active-color`.
Do not create dev parameters: nothing in dev would flip them back.

## Adoption rule

`await gate.start()` BEFORE starting any consumer, relay or scheduled job. Until the first read lands the gate is active
(fail-open), so an idle-colour task that starts its consumers first consumes live traffic until the read completes.
`start()` is bounded by `bootTimeoutMs` and never throws.
