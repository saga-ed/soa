import { describe, it, expect } from 'vitest';
import {
  DATADOG_RUM_TRACING_HEADERS,
  buildSagaOriginAllowlist,
  originAllowed,
} from './cors.js';

describe('DATADOG_RUM_TRACING_HEADERS', () => {
  it('contains all seven Datadog RUM tracing headers', () => {
    expect([...DATADOG_RUM_TRACING_HEADERS]).toEqual([
      'traceparent',
      'tracestate',
      'x-datadog-trace-id',
      'x-datadog-parent-id',
      'x-datadog-origin',
      'x-datadog-sampling-priority',
      'x-datadog-tags',
    ]);
  });
});

describe('buildSagaOriginAllowlist', () => {
  it('dev (default): includes the *.wootdev.com wildcard, NOT *.saga.org', () => {
    const list = buildSagaOriginAllowlist({ env: {} });
    expect(list.some((e) => e instanceof RegExp && e.source.includes('wootdev'))).toBe(true);
    expect(list.some((e) => e instanceof RegExp && e.source.includes('saga'))).toBe(false);
  });

  it('prod: includes the *.saga.org wildcard, NOT *.wootdev.com', () => {
    const list = buildSagaOriginAllowlist({ env: { NODE_ENV: 'production' } });
    expect(list.some((e) => e instanceof RegExp && e.source.includes('saga'))).toBe(true);
    expect(list.some((e) => e instanceof RegExp && e.source.includes('wootdev'))).toBe(false);
  });

  it('includes explicit CORS_ORIGIN entries (trimmed, empties dropped)', () => {
    const list = buildSagaOriginAllowlist({
      env: { CORS_ORIGIN: 'https://a.example.org, https://b.example.org ,' },
    });
    expect(list).toContain('https://a.example.org');
    expect(list).toContain('https://b.example.org');
    expect(list).not.toContain('');
  });

  it('adds devOrigins in non-prod only', () => {
    const dev = buildSagaOriginAllowlist({ env: {}, devOrigins: ['http://localhost:5173'] });
    expect(dev).toContain('http://localhost:5173');

    const prod = buildSagaOriginAllowlist({ env: { NODE_ENV: 'production' }, devOrigins: ['http://localhost:5173'] });
    expect(prod).not.toContain('http://localhost:5173');
  });
});

describe('originAllowed', () => {
  const devList = buildSagaOriginAllowlist({ env: {}, devOrigins: ['http://localhost:5173'] });
  const prodList = buildSagaOriginAllowlist({ env: { NODE_ENV: 'production' } });

  it('matches an exact string entry', () => {
    expect(originAllowed(devList, 'http://localhost:5173')).toBe(true);
  });

  it('matches multi-level subdomains under the env wildcard', () => {
    expect(originAllowed(devList, 'https://pr-12.dash.wootdev.com')).toBe(true);
    expect(originAllowed(prodList, 'https://stable.dash.saga.org')).toBe(true);
  });

  it('isolates: dev rejects saga.org, prod rejects wootdev.com', () => {
    expect(originAllowed(devList, 'https://login.saga.org')).toBe(false);
    expect(originAllowed(prodList, 'https://login.wootdev.com')).toBe(false);
  });

  it('rejects unknown / undefined / suffix-attack origins', () => {
    expect(originAllowed(devList, 'https://attacker.example.org')).toBe(false);
    expect(originAllowed(devList, undefined)).toBe(false);
    expect(originAllowed(devList, 'https://wootdev.com.attacker.org')).toBe(false);
  });

  it('rejects non-https origins', () => {
    expect(originAllowed(devList, 'http://app.wootdev.com')).toBe(false);
  });
});
