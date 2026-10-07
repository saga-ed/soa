import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { resolveOtlpMetricsUrl } from './tracing.js';

beforeEach(() => {
    vi.stubEnv('OTEL_TRACES_DISABLED', '');
    vi.stubEnv('OTEL_METRICS_EXPORTER', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('resolveOtlpMetricsUrl', () => {
    it('uses OTEL_EXPORTER_OTLP_METRICS_ENDPOINT as-is', () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://collector:4318/custom');
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://other:4318');

        expect(resolveOtlpMetricsUrl()).toBe('http://collector:4318/custom');
    });

    it('appends /v1/metrics to the base endpoint', () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://10.0.0.1:4318');

        expect(resolveOtlpMetricsUrl()).toBe('http://10.0.0.1:4318/v1/metrics');
    });

    it('tolerates a trailing slash on the base endpoint', () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://10.0.0.1:4318/');

        expect(resolveOtlpMetricsUrl()).toBe('http://10.0.0.1:4318/v1/metrics');
    });

    it('swaps a base endpoint that already ends in /v1/traces', () => {
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://10.0.0.1:4318/v1/traces');

        expect(resolveOtlpMetricsUrl()).toBe('http://10.0.0.1:4318/v1/metrics');
    });

    it('is off when no endpoint is set (local dev)', () => {
        expect(resolveOtlpMetricsUrl()).toBeUndefined();
    });

    it('is off when OTEL_METRICS_EXPORTER=none', () => {
        vi.stubEnv('OTEL_METRICS_EXPORTER', 'none');
        vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://10.0.0.1:4318');

        expect(resolveOtlpMetricsUrl()).toBeUndefined();
    });

    it('is off when OTEL_TRACES_DISABLED=true', () => {
        vi.stubEnv('OTEL_TRACES_DISABLED', 'true');
        vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'http://collector:4318/v1/metrics');

        expect(resolveOtlpMetricsUrl()).toBeUndefined();
    });
});
