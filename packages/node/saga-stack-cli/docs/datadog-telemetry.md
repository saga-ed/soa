# Synthetic-dev Datadog telemetry

The local Datadog Agent accepts existing SOA OpenTelemetry exports. No custom
collector or API latency timers are required. This is opt-in and does not change
normal `ss` launches.

## Start the local receiver

Provide `DD_API_KEY` through your credential environment, then run from the CLI
package directory:

```sh
node scripts/datadog-agent.mjs start
node scripts/datadog-agent.mjs status
```

The helper uses Datadog Agent 7.84.0 pinned by image digest, publishes OTLP/HTTP
only on `127.0.0.1:4318`, and keeps keys out of arguments and files. Docker retains
the key in container configuration; normal Docker access can inspect it. No Docker
socket, host filesystem, logs or process collection is mounted/enabled. Override
`SS_DATADOG_AGENT_IMAGE` deliberately when upgrading. An existing container is
retained without replacing configuration. The Agent is shared by this machine's
slots and is independent of slot teardown.

## Launch instrumented services

```sh
SS_ACTOR=telemetry SS_TELEMETRY=datadog ss stack up --set gh536 \
  --only iam-api,programs-api,scheduling-api,vishnu --no-auto-pull --no-seed
```

Use the checkout's built `node packages/node/saga-stack-cli/bin/run.js` from its
repository root if the global CLI predates this feature. Follow normal ss prep
rules; use `--skip-prep` only when the service builds are already current.

Already-running services must be restarted to receive the new telemetry settings.
The adoption guard refuses to silently reuse an instance with a different scope
or OTLP endpoint. Preserve database state (`--no-seed`, no reset or mesh teardown).
Only restart services belonging to the chosen slot.

The opt-in overlay sets:

- `env=synthetic`, `deployment.identifier=slot-N`, `synthetic.slot=N`.
- `synthetic.machine=<hostname>` (override with `SS_TELEMETRY_MACHINE`). Use a
  unique machine name across developers; the reader must filter machine AND slot.
- Service version from each checkout's Git revision, suffixed `-dirty` for tracked
  modifications. Service names remain owned by `initTracing`.
- OTLP trace/metric endpoints on loopback port 4318; override the base URL with
  `SS_TELEMETRY_ENDPOINT` (loopback HTTP only).
- SDK sampling `always_on` for bounded local investigations. Datadog ingestion and
  retention may still sample; verify coverage rather than promising complete traces.

The overlay supplies no credentials to applications. Vishnu's server-side reader
separately needs `DD_API_KEY` and `DD_APP_KEY`; scope them to its launch, not the
whole application stack. Plain browser SPAs do not receive this overlay.

## Verify

Check Agent status for OTLP enabled/running and API authorization. Exercise a
non-health route (health routes intentionally have no server span), then verify
Datadog spans have all three environment/machine/deployment scope attributes.
For example: `env:synthetic @synthetic.machine:turing @deployment.identifier:slot-3`.
Check connected parent/child spans before claiming distributed coverage.

Resource attributes are not automatically dimensions of every standard APM
metric. If a metric cannot filter both machine and slot, keep that measurement
unavailable or use correctly scoped span analytics; never silently show the
environment-wide total as a slot measurement.

References: [Agent OTLP intake](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/),
[trace metrics](https://docs.datadoghq.com/tracing/metrics/metrics_namespace/).
