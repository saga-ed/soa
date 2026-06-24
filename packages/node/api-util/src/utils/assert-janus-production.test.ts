import { describe, it, expect } from 'vitest';
import {
  janusProductionViolation,
  assertJanusProductionConfig,
} from './assert-janus-production.js';

/**
 * @spec specs/contracts/saga-auth-signal.spec.md (janus repo)
 *
 * Boot guard for the Janus perimeter. Migrated from the 5 janus cases in
 * rostering iam-api's `assert-production-config.test.ts` so the invariant is
 * tested at its canonical source. The aggregate asserter in rostering now just
 * asserts the janus violation is included in its collected list.
 */

describe('janusProductionViolation', () => {
  it('returns null when the perimeter is required (the prod default)', () => {
    expect(janusProductionViolation({ required: true }, 'production')).toBeNull();
  });

  it('returns null when janus-off but NODE_ENV=development (dev escape hatch)', () => {
    expect(janusProductionViolation({ required: false }, 'development')).toBeNull();
  });

  it('returns null when janus-off but NODE_ENV=test', () => {
    expect(janusProductionViolation({ required: false }, 'test')).toBeNull();
  });

  it('returns a violation when janus-off in production', () => {
    const v = janusProductionViolation({ required: false }, 'production');
    expect(v).toContain('JANUS_REQUIRED must be true');
    expect(v).toContain('NODE_ENV=production');
  });

  it('returns a violation when janus-off and NODE_ENV is unset (fail-closed)', () => {
    // An unset NODE_ENV is NOT local-dev — staging/preview/canary land here too.
    const v = janusProductionViolation({ required: false }, undefined);
    expect(v).toContain('JANUS_REQUIRED must be true');
    expect(v).toContain('NODE_ENV=(unset)');
  });

  it('treats an unrecognized NODE_ENV (e.g. staging) as non-local-dev', () => {
    expect(janusProductionViolation({ required: false }, 'staging')).not.toBeNull();
  });
});

describe('assertJanusProductionConfig', () => {
  it('does not throw when the config is acceptable', () => {
    expect(() => assertJanusProductionConfig({ required: true }, 'production')).not.toThrow();
    expect(() => assertJanusProductionConfig({ required: false }, 'development')).not.toThrow();
  });

  it('throws with the violation message when janus-off in production', () => {
    expect(() => assertJanusProductionConfig({ required: false }, 'production')).toThrow(
      /JANUS_REQUIRED must be true/,
    );
  });
});
