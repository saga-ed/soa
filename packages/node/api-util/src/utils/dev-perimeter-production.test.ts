import { describe, it, expect } from 'vitest';
import {
  devPerimeterProductionViolation,
  assertDevPerimeterProductionConfig,
  janusProductionViolation,
} from './dev-perimeter-production.js';

/**
 * @spec specs/contracts/saga-auth-signal.spec.md (janus repo)
 *
 * Boot guard for the dev recon perimeter. INVERTED from the old
 * janusProductionViolation: prod *.saga.org services are end-user facing and
 * authenticate via iam-api only, so the perimeter must be OFF in production —
 * this guard refuses to boot with it ON. Non-prod keeps the perimeter (default
 * ON) for dev/preview recon protection.
 */

describe('devPerimeterProductionViolation', () => {
  it('returns null when the perimeter is OFF in production (the prod posture)', () => {
    expect(devPerimeterProductionViolation({ enabled: false }, 'production')).toBeNull();
  });

  it('returns a violation when the perimeter is ON in production', () => {
    const v = devPerimeterProductionViolation({ enabled: true }, 'production');
    expect(v).toContain('DEV_PERIMETER_ENABLED must be false in production');
    expect(v).toContain('NODE_ENV=production');
  });

  it('returns null when the perimeter is ON in development (recon protection)', () => {
    expect(devPerimeterProductionViolation({ enabled: true }, 'development')).toBeNull();
  });

  it('returns null when the perimeter is ON in test', () => {
    expect(devPerimeterProductionViolation({ enabled: true }, 'test')).toBeNull();
  });

  it('returns null when the perimeter is ON in staging/preview (non-prod, allowed)', () => {
    // Only NODE_ENV=production forces the perimeter off; previews keep recon
    // protection. The real task-env fork emits only production|development.
    expect(devPerimeterProductionViolation({ enabled: true }, 'staging')).toBeNull();
  });

  it('returns null when the perimeter is ON and NODE_ENV is unset (non-prod)', () => {
    expect(devPerimeterProductionViolation({ enabled: true }, undefined)).toBeNull();
  });
});

describe('assertDevPerimeterProductionConfig', () => {
  it('does not throw when the config is acceptable', () => {
    expect(() =>
      assertDevPerimeterProductionConfig({ enabled: false }, 'production'),
    ).not.toThrow();
    expect(() =>
      assertDevPerimeterProductionConfig({ enabled: true }, 'development'),
    ).not.toThrow();
  });

  it('throws with the violation message when the perimeter is ON in production', () => {
    expect(() => assertDevPerimeterProductionConfig({ enabled: true }, 'production')).toThrow(
      /DEV_PERIMETER_ENABLED must be false in production/,
    );
  });
});

describe('legacy janusProductionViolation alias (deprecated — now inverted semantics)', () => {
  it('maps required→enabled and applies the NEW prod-off-only rule', () => {
    // required:true (perimeter on) in prod is now a violation (was OK before).
    expect(janusProductionViolation({ required: true }, 'production')).not.toBeNull();
    // required:false (perimeter off) in prod is now fine (was a violation before).
    expect(janusProductionViolation({ required: false }, 'production')).toBeNull();
  });
});
