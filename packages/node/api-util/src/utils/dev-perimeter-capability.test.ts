import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertDevPerimeterProductionConfig,
  devPerimeterProductionViolation,
  resetDevPerimeterFallbackWarning,
} from './dev-perimeter-production.js';

const spyWarn = () => vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

describe('devPerimeterProductionViolation capability form', () => {
  const origNodeEnv = process.env.NODE_ENV;
  let warn: ReturnType<typeof spyWarn>;

  beforeEach(() => {
    resetDevPerimeterFallbackWarning();
    warn = spyWarn();
  });
  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    warn.mockRestore();
  });

  it('devPerimeter=off + enabled is a violation regardless of NODE_ENV', () => {
    for (const env of ['production', 'development']) {
      process.env.NODE_ENV = env;
      const v = devPerimeterProductionViolation({ enabled: true }, { devPerimeter: 'off' });
      expect(v).toContain('devPerimeter capability is off');
    }
    expect(() =>
      assertDevPerimeterProductionConfig({ enabled: true }, { devPerimeter: 'off' }),
    ).toThrow(/devPerimeter/);
  });

  it('devPerimeter=on is never a violation, even with NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(devPerimeterProductionViolation({ enabled: true }, { devPerimeter: 'on' })).toBeNull();
    expect(devPerimeterProductionViolation({ enabled: false }, { devPerimeter: 'off' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('string form keeps legacy behaviour and warns exactly once across two calls', () => {
    expect(devPerimeterProductionViolation({ enabled: true }, 'production')).toContain(
      'NODE_ENV=production',
    );
    expect(devPerimeterProductionViolation({ enabled: true }, 'development')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('soa#515'),
      expect.objectContaining({
        type: 'DeprecationWarning',
        code: 'SOA_ENV_FALLBACK_DEV_PERIMETER',
      }),
    );
  });
});
