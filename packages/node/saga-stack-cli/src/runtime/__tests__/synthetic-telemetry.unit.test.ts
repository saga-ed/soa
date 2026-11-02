import { describe, expect, it } from 'vitest';
import type { RepoKey } from '../../core/manifest/index.js';
import { readSyntheticTelemetry } from '../synthetic-telemetry.js';

const roots = {} as Record<RepoKey, string>;
describe('synthetic telemetry configuration', () => {
  it('requires explicit opt-in', () => {
    expect(readSyntheticTelemetry(roots, {})).toBeUndefined();
  });

  it('accepts a local receiver and explicit machine identity', () => {
    expect(readSyntheticTelemetry(roots, { SS_TELEMETRY: 'datadog', SS_TELEMETRY_MACHINE: 'test-host', SS_TELEMETRY_ENDPOINT: 'http://localhost:5318' }))
      .toEqual({ machine: 'test-host', endpoint: 'http://localhost:5318', versions: {} });
  });

  it.each(['https://example.com', 'http://user:secret@localhost:4318', 'http://localhost:4318/v1/traces', 'http://localhost:4318?token=secret'])('rejects non-local or credential-bearing receiver URLs', endpoint => {
    expect(() => readSyntheticTelemetry(roots, { SS_TELEMETRY: 'datadog', SS_TELEMETRY_ENDPOINT: endpoint })).toThrow();
  });

  it('rejects machine values that could inject scope attributes', () => {
    expect(() => readSyntheticTelemetry(roots, { SS_TELEMETRY: 'datadog', SS_TELEMETRY_MACHINE: 'host,env=prod' })).toThrow('Invalid SS_TELEMETRY_MACHINE');
  });
});
