import { generateKeyPair, exportJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { JanusClaimsSchema } from '../claims.js';
import { setJanusCookieHeader, readJanusCookie } from '../cookie.js';
import { mintJanusToken } from '../mint.js';

describe('Janus claims schema', () => {
  it('accepts a well-formed claim set', () => {
    const claims = {
      iss: 'janus',
      aud: 'wootdev',
      sub: 'jc-user-123',
      email: 'dev@saga.org',
      name: 'Dev User',
      permissions: [],
      iat: 1_700_000_000,
      exp: 1_700_028_800,
      authTime: 1_700_000_000,
    };
    expect(JanusClaimsSchema.parse(claims)).toEqual(claims);
  });

  it('rejects wrong issuer', () => {
    expect(() =>
      JanusClaimsSchema.parse({
        iss: 'not-janus',
        aud: 'wootdev',
        sub: 'x',
        email: 'a@b.com',
        name: '',
        permissions: [],
        iat: 0,
        exp: 0,
        authTime: 0,
      }),
    ).toThrow();
  });

  it('accepts an empty email — email is informational, not gating data', () => {
    const claims = {
      iss: 'janus',
      aud: 'wootdev',
      sub: 'jc-user-123',
      email: '',
      name: 'Dev User',
      permissions: [],
      iat: 1_700_000_000,
      exp: 1_700_028_800,
      authTime: 1_700_000_000,
    };
    expect(JanusClaimsSchema.parse(claims)).toEqual(claims);
  });

  it('rejects empty subject', () => {
    expect(() =>
      JanusClaimsSchema.parse({
        iss: 'janus',
        aud: 'wootdev',
        sub: '',
        email: 'a@b.com',
        name: '',
        permissions: [],
        iat: 0,
        exp: 0,
        authTime: 0,
      }),
    ).toThrow();
  });
});

describe('cookie helpers', () => {
  it('round-trips a token through serialize/parse', () => {
    const header = setJanusCookieHeader('abc.def.ghi', { domain: '.wootdev.com' });
    expect(header).toContain('janus_session=abc.def.ghi');
    expect(header).toContain('Domain=.wootdev.com');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    // Parse back from a Cookie request header (not Set-Cookie).
    expect(readJanusCookie('janus_session=abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null when cookie is absent', () => {
    expect(readJanusCookie(undefined)).toBeNull();
    expect(readJanusCookie('other=foo')).toBeNull();
  });
});

describe('mint', () => {
  it('produces a JWT with EdDSA header and required protected fields', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const token = await mintJanusToken(
      {
        sub: 'jc-user-123',
        email: 'dev@saga.org',
        name: 'Dev User',
        groups: ['saga-engineering'],
        permissions: [],
        authTime: 1_700_000_000,
      },
      { privateKey, kid: 'k-2026-04', now: () => 1_700_000_000 },
    );

    const [header] = token.split('.');
    const decoded = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: 'k-2026-04' });
  });

  it('exports a public key in JWK form (sanity for JWKS)', async () => {
    const { publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwk = await exportJWK(publicKey);
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(typeof jwk.x).toBe('string');
  });
});
