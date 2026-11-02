import { describe, expect, it } from 'vitest';
import { syntheticTelemetryEnv } from '../telemetry.js';
import { defaultLaunchContext, resolveLaunchEnv } from '../launch-plan.js';
import { manifest } from '../manifest/index.js';
import type { RepoKey } from '../manifest/index.js';

const repoRoots = Object.fromEntries(Object.values(manifest.services).map(s => [s.repo, `/repos/${s.repo}`])) as Record<RepoKey, string>;
const telemetry = { machine: 'turing', endpoint: 'http://127.0.0.1:4318', versions: { ROSTERING: 'abc-dirty' } };

describe('synthetic telemetry launch contract', () => {
  it('keeps default launches unchanged and scopes opt-in API exports to machine and slot', () => {
    const base = { repoRoots, vendorDir: '/vendor', meshOffset: 3000 };
    expect(resolveLaunchEnv('iam-api', 'stack', defaultLaunchContext(base))).not.toHaveProperty('OTEL_RESOURCE_ATTRIBUTES');
    const env = resolveLaunchEnv('iam-api', 'stack', defaultLaunchContext({ ...base, telemetry }));
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('deployment.identifier=slot-3');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('synthetic.machine=turing');
    expect(env.DD_VERSION).toBe('abc-dirty');
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://127.0.0.1:4318/v1/traces');
    expect(env.OTEL_TRACES_DISABLED).toBe('false');
  });

  it('does not export server telemetry configuration into browser apps', () => {
    const ctx = defaultLaunchContext({ repoRoots, vendorDir: '/vendor', telemetry });
    expect(resolveLaunchEnv('saga-dash', 'stack', ctx)).not.toHaveProperty('OTEL_RESOURCE_ATTRIBUTES');
    expect(resolveLaunchEnv('vishnu', 'stack', ctx).VISHNU_DATADOG_MACHINE).toBe('turing');
  });

  it('changes scope across slots and never supplies credentials', () => {
    const a = syntheticTelemetryEnv(telemetry, '3', 'ROSTERING');
    const b = syntheticTelemetryEnv(telemetry, '4', 'ROSTERING');
    expect(a.OTEL_RESOURCE_ATTRIBUTES).not.toBe(b.OTEL_RESOURCE_ATTRIBUTES);
    expect(a).not.toHaveProperty('DD_API_KEY');
    expect(a).not.toHaveProperty('DD_APP_KEY');
  });
});
