import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadDevPerimeterConfig,
  DevPerimeterConfigSchema,
  loadJanusConfig,
} from './dev-perimeter-config.js';

/**
 * @spec specs/contracts/saga-auth-signal.spec.md (janus repo)
 *
 * The dev recon perimeter config loader (renamed from janus-config). The
 * fail-safe `enabled` semantics are the security invariant the unattended-e2e
 * initiative rests on: only the literal "false" disables.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadDevPerimeterConfig', () => {
  it('defaults enabled to true when DEV_PERIMETER_ENABLED is unset', () => {
    expect(loadDevPerimeterConfig({}).enabled).toBe(true);
  });

  it('disables the perimeter only for the literal string "false"', () => {
    expect(loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('keeps the perimeter ON for "true"', () => {
    expect(loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('keeps the perimeter ON for a typo (fail-safe — never silently opens)', () => {
    expect(loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: 'flase' }).enabled).toBe(true);
    expect(loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: 'False' }).enabled).toBe(true);
    expect(loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: '0' }).enabled).toBe(true);
    expect(loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: '' }).enabled).toBe(true);
  });

  it('defaults jwksUrl to the wootdev gate', () => {
    expect(loadDevPerimeterConfig({}).jwksUrl).toBe(
      'https://gate.wootdev.com/.well-known/jwks.json',
    );
  });

  it('reads JANUS_JWKS_URL and JANUS_LOGIN_HOST verbatim', () => {
    const config = loadDevPerimeterConfig({
      JANUS_JWKS_URL: 'https://gate.saga.org/.well-known/jwks.json',
      JANUS_LOGIN_HOST: 'login.saga.org',
    });
    expect(config.jwksUrl).toBe('https://gate.saga.org/.well-known/jwks.json');
    expect(config.loginHost).toBe('login.saga.org');
  });

  it('rejects a non-URL JANUS_JWKS_URL', () => {
    expect(() => loadDevPerimeterConfig({ JANUS_JWKS_URL: 'not-a-url' })).toThrow();
  });

  it('stamps the DEV_PERIMETER configType discriminator', () => {
    expect(loadDevPerimeterConfig({}).configType).toBe('DEV_PERIMETER');
  });

  it('schema parses an empty object to the all-defaults config', () => {
    expect(DevPerimeterConfigSchema.parse({})).toEqual({
      configType: 'DEV_PERIMETER',
      enabled: true,
      jwksUrl: 'https://gate.wootdev.com/.well-known/jwks.json',
    });
  });
});

describe('legacy JANUS_REQUIRED alias (deprecated, one-release back-compat)', () => {
  it('honors JANUS_REQUIRED=false when DEV_PERIMETER_ENABLED is unset (warns)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadDevPerimeterConfig({ JANUS_REQUIRED: 'false' }).enabled).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('JANUS_REQUIRED is deprecated');
  });

  it('honors JANUS_REQUIRED=false fail-safe (only literal "false")', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadDevPerimeterConfig({ JANUS_REQUIRED: 'flase' }).enabled).toBe(true);
  });

  it('the new name wins and does NOT warn when both are set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      loadDevPerimeterConfig({ DEV_PERIMETER_ENABLED: 'true', JANUS_REQUIRED: 'false' }).enabled,
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('deprecated loadJanusConfig maps enabled→required', () => {
    expect(loadJanusConfig({}).required).toBe(true);
    expect(loadJanusConfig({ DEV_PERIMETER_ENABLED: 'false' }).required).toBe(false);
    expect(loadJanusConfig({}).configType).toBe('JANUS');
  });
});
