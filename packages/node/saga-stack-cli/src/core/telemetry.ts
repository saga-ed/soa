import type { RepoKey } from './manifest/index.js';

export interface SyntheticTelemetry {
  machine: string;
  endpoint: string;
  versions: Partial<Record<RepoKey, string>>;
}

/** Service identity remains owned by initTracing; scope is owned by the slot. */
export function syntheticTelemetryEnv(config: SyntheticTelemetry, slot: string, repo: RepoKey): Record<string, string> {
  const version = config.versions[repo];
  return {
    OTEL_TRACES_DISABLED: 'false',
    OTEL_TRACES_SAMPLER: 'always_on',
    OTEL_EXPORTER_OTLP_ENDPOINT: config.endpoint,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${config.endpoint}/v1/traces`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${config.endpoint}/v1/metrics`,
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=synthetic,deployment.environment=synthetic,deployment.identifier=slot-${slot},synthetic.machine=${config.machine},synthetic.slot=${slot}`,
    DD_ENV: 'synthetic',
    ...(version ? { DD_VERSION: version, OTEL_SERVICE_VERSION: version } : {}),
    VISHNU_DATADOG_ENV: 'synthetic',
    VISHNU_DATADOG_SCOPE: 'deployment',
    VISHNU_DATADOG_DEPLOYMENT: `slot-${slot}`,
    VISHNU_DATADOG_MACHINE: config.machine,
  };
}
