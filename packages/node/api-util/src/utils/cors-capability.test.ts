import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSagaOriginAllowlist, resetCorsFallbackWarning } from './cors.js';

const spyWarn = () => vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

describe('buildSagaOriginAllowlist corsOrigins capability', () => {
  const origNodeEnv = process.env.NODE_ENV;
  let warn: ReturnType<typeof spyWarn>;

  beforeEach(() => {
    resetCorsFallbackWarning();
    warn = spyWarn();
  });
  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    warn.mockRestore();
  });

  it('returns exactly the capability list under NODE_ENV=production, adding nothing', () => {
    process.env.NODE_ENV = 'production';
    const dev = /^https:\/\/dev\.wootdev\.com$/;
    const out = buildSagaOriginAllowlist({
      corsOrigins: ['http://localhost:5173', dev],
      env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://extra.example.com' },
      devOrigins: ['http://localhost:9999'],
    });
    expect(out).toEqual(['http://localhost:5173', dev]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns exactly the capability list under NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    const prod = /^https:\/\/([a-z0-9-]+\.)+saga\.org$/;
    expect(buildSagaOriginAllowlist({ corsOrigins: [prod] })).toEqual([prod]);
  });

  it('returns a copy, not the caller array', () => {
    const src = ['https://a.example.com'] as const;
    const out = buildSagaOriginAllowlist({ corsOrigins: src });
    expect(out).not.toBe(src);
    expect(out).toEqual([...src]);
  });

  it('falls back to NODE_ENV and warns exactly once across two calls', () => {
    const a = buildSagaOriginAllowlist({ env: { NODE_ENV: 'production' } });
    const b = buildSagaOriginAllowlist({ env: { NODE_ENV: 'development' } });
    expect(a).toHaveLength(1);
    expect(String(a[0])).toContain('saga');
    expect(String(b[0])).toContain('wootdev');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('soa#515'),
      expect.objectContaining({ type: 'DeprecationWarning', code: 'SOA_ENV_FALLBACK_CORS' }),
    );
  });
});
