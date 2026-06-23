import { describe, it, expect } from 'vitest';
import { loadJanusConfig, JanusConfigSchema } from './janus-config.js';

/**
 * @spec specs/contracts/saga-auth-signal.spec.md (janus repo)
 *
 * The Janus perimeter config loader. Ported from the byte-/behavior-identical
 * copies previously living in program-hub-service-kit, rostering's iam-api, and
 * qboard's connectv3-api. The fail-safe `required` semantics below are the
 * security invariant the whole unattended-e2e initiative rests on.
 */

describe('loadJanusConfig', () => {
  it('defaults required to true when JANUS_REQUIRED is unset', () => {
    expect(loadJanusConfig({}).required).toBe(true);
  });

  it('disables the perimeter only for the literal string "false"', () => {
    expect(loadJanusConfig({ JANUS_REQUIRED: 'false' }).required).toBe(false);
  });

  it('keeps the perimeter ON for "true"', () => {
    expect(loadJanusConfig({ JANUS_REQUIRED: 'true' }).required).toBe(true);
  });

  it('keeps the perimeter ON for a typo (fail-safe — never silently opens)', () => {
    // The crux: anything that is not exactly "false" must leave the gate up.
    expect(loadJanusConfig({ JANUS_REQUIRED: 'flase' }).required).toBe(true);
    expect(loadJanusConfig({ JANUS_REQUIRED: 'False' }).required).toBe(true);
    expect(loadJanusConfig({ JANUS_REQUIRED: '0' }).required).toBe(true);
    expect(loadJanusConfig({ JANUS_REQUIRED: '' }).required).toBe(true);
  });

  it('defaults jwksUrl to the wootdev gate', () => {
    expect(loadJanusConfig({}).jwksUrl).toBe('https://gate.wootdev.com/.well-known/jwks.json');
  });

  it('reads JANUS_JWKS_URL and JANUS_LOGIN_HOST verbatim', () => {
    const config = loadJanusConfig({
      JANUS_JWKS_URL: 'https://gate.saga.org/.well-known/jwks.json',
      JANUS_LOGIN_HOST: 'login.saga.org',
    });
    expect(config.jwksUrl).toBe('https://gate.saga.org/.well-known/jwks.json');
    expect(config.loginHost).toBe('login.saga.org');
  });

  it('rejects a non-URL JANUS_JWKS_URL', () => {
    expect(() => loadJanusConfig({ JANUS_JWKS_URL: 'not-a-url' })).toThrow();
  });

  it('stamps the JANUS configType discriminator', () => {
    expect(loadJanusConfig({}).configType).toBe('JANUS');
  });

  it('schema parses an empty object to the all-defaults config', () => {
    expect(JanusConfigSchema.parse({})).toEqual({
      configType: 'JANUS',
      required: true,
      jwksUrl: 'https://gate.wootdev.com/.well-known/jwks.json',
    });
  });
});
