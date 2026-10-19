import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EnvInvariantError,
  createEnv,
  loadEnv,
  type CapabilityDeclaration,
  type EnvIdentity,
  type InvariantRow,
} from '../index.js';
import { DEV_ACCOUNT_ID, PROD_ACCOUNT_ID } from '../account.js';
import { testEnv } from '../testing.js';
import { decl, source, validConfig } from './fixtures.js';

const identityFor = (row: InvariantRow): EnvIdentity => {
  switch (row) {
    case 'R1-prod':
      return {
        profile: 'prod',
        lane: 'none',
        telemetryEnv: 'prod',
        account: { kind: 'prod', id: PROD_ACCOUNT_ID },
        row,
      };
    case 'R2-lane':
      return {
        profile: 'prod',
        lane: 'twin',
        telemetryEnv: 'twin',
        account: { kind: 'dev', id: DEV_ACCOUNT_ID },
        row,
      };
    case 'R3-dev-overlay':
      return {
        profile: 'dev',
        lane: 'none',
        telemetryEnv: 'dev',
        account: { kind: 'dev', id: DEV_ACCOUNT_ID },
        row,
      };
    case 'R4-local':
      return {
        profile: 'prod',
        lane: 'none',
        telemetryEnv: 'dev',
        account: { kind: 'local' },
        row,
      };
  }
};

const rows: InvariantRow[] = ['R1-prod', 'R2-lane', 'R3-dev-overlay', 'R4-local'];

function violationsOf(
  row: InvariantRow,
  changes: Record<string, string | undefined>,
  d = decl
): string[] {
  const values: Record<string, string | undefined> = { ...validConfig[row], ...changes };
  try {
    createEnv(d, identityFor(row), { get: k => values[k] });
  } catch (err) {
    expect(err).toBeInstanceOf(EnvInvariantError);
    return [...(err as EnvInvariantError).violations];
  }
  return [];
}

describe('createEnv: valid configuration per row', () => {
  it.each(rows)('%s accepts its valid config and returns frozen capabilities', row => {
    const caps = createEnv(
      decl,
      identityFor(row),
      source(validConfig[row] as Record<string, string>)
    );
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.outbound)).toBe(true);
    expect(Object.isFrozen(caps.tls)).toBe(true);
    expect(Object.isFrozen(caps.corsOrigins)).toBe(true);
    expect(caps.trustProxyHops).toBe(1);
    expect(caps.cookieDomain).toBe('.example.org');
  });

  it('parses tls, origins and outbound encodings', () => {
    const caps = createEnv(
      decl,
      identityFor('R1-prod'),
      source(validConfig['R1-prod'] as Record<string, string>)
    );
    expect(caps.tls).toEqual({ required: true, caBundlePath: '/etc/ssl/rds-ca.pem' });
    expect(caps.outbound).toEqual({ clever: 'live', 'lake-export': 'live' });
    const withRegex = createEnv(
      decl,
      identityFor('R3-dev-overlay'),
      source({
        ...validConfig['R3-dev-overlay'],
        CORS: 'https://a.example.org, /^https:\\/\\/pr-\\d+\\.example\\.org$/',
      } as Record<string, string>)
    );
    expect(withRegex.corsOrigins[0]).toBe('https://a.example.org');
    expect(withRegex.corsOrigins[1]).toBeInstanceOf(RegExp);
  });
});

describe('createEnv: invariant table', () => {
  describe.each([
    ['R1-prod', 'failFast', { FAIL_FAST: 'false' }],
    ['R1-prod', 'credentialSource', { CRED: 'static' }],
    ['R1-prod', 'tls without CA', { TLS: 'required' }],
    ['R1-prod', 'tls off', { TLS: 'off' }],
    ['R1-prod', 'mailSink capture', { MAIL: 'capture' }],
    ['R1-prod', 'mailSink stub', { MAIL: 'stub' }],
    ['R1-prod', 'outbound sink', { OUTBOUND: 'clever=sink,lake-export=live' }],
    ['R1-prod', 'outbound off', { OUTBOUND: 'clever=off,lake-export=live' }],
    ['R1-prod', 'telemetryEnv', { TELEMETRY: 'dev' }],
    ['R1-prod', 'devPerimeter', { PERIMETER: 'on' }],
    ['R1-prod', 'permissiveAuthz', { PERMISSIVE: 'true' }],
    ['R1-prod', 'dev origin localhost', { CORS: 'https://app.example.org,http://localhost:3000' }],
    ['R1-prod', 'dev origin wootdev', { CORS: 'https://dash.wootdev.com' }],
    ['R2-lane', 'failFast', { FAIL_FAST: 'false' }],
    ['R2-lane', 'credentialSource', { CRED: 'static' }],
    ['R2-lane', 'tls', { TLS: 'off' }],
    ['R2-lane', 'devPerimeter', { PERIMETER: 'on' }],
    ['R2-lane', 'telemetryEnv prod', { TELEMETRY: 'prod' }],
    ['R2-lane', 'mailSink ses', { MAIL: 'ses' }],
    ['R2-lane', 'mailSink stub', { MAIL: 'stub' }],
    ['R2-lane', 'live outbound', { OUTBOUND: 'clever=live,lake-export=off' }],
    ['R2-lane', 'permissiveAuthz', { PERMISSIVE: 'true' }],
    ['R3-dev-overlay', 'telemetryEnv', { TELEMETRY: 'prod' }],
    ['R3-dev-overlay', 'mailSink ses', { MAIL: 'ses' }],
    ['R3-dev-overlay', 'permissiveAuthz', { PERMISSIVE: 'true' }],
    ['R4-local', 'credentialSource', { CRED: 'iam-token' }],
    ['R4-local', 'mailSink ses', { MAIL: 'ses' }],
    ['R4-local', 'live outbound', { OUTBOUND: 'clever=live,lake-export=off' }],
  ] as [InvariantRow, string, Record<string, string>][])('%s', (row, label, change) => {
    it(`rejects ${label}`, () => {
      const violations = violationsOf(row, change);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.every(v => v.startsWith(`${row}:`) || /config key/.test(v))).toBe(true);
    });
  });

  it('permissiveAuthz is legal only in the local row', () => {
    expect(violationsOf('R4-local', { PERMISSIVE: 'true' })).toEqual([]);
    for (const row of ['R1-prod', 'R2-lane', 'R3-dev-overlay'] as const) {
      expect(violationsOf(row, { PERMISSIVE: 'true' }).join()).toMatch(/permissiveAuthz/);
    }
  });

  it('R3 leaves failFast, credentialSource, outbound and devPerimeter unconstrained', () => {
    expect(
      violationsOf('R3-dev-overlay', {
        FAIL_FAST: 'true',
        CRED: 'iam-token',
        PERIMETER: 'off',
        OUTBOUND: 'clever=off,lake-export=sink',
      })
    ).toEqual([]);
  });

  it('mail is only required to be ses/capture when the declaration lists it', () => {
    const noMail: CapabilityDeclaration = { ...decl, keys: { ...decl.keys } };
    delete noMail.keys.mailSink;
    expect(violationsOf('R1-prod', { MAIL: undefined }, noMail)).toEqual([]);
    expect(violationsOf('R2-lane', { MAIL: undefined }, noMail)).toEqual([]);
    const caps = createEnv(
      noMail,
      identityFor('R1-prod'),
      source(validConfig['R1-prod'] as Record<string, string>)
    );
    expect(caps.mailSink).toBe('stub');
  });
});

describe('createEnv: strict reads', () => {
  it('a missing key throws, naming the key', () => {
    const v = violationsOf('R3-dev-overlay', { LOG_LEVEL: undefined });
    expect(v).toEqual(['logLevel: config key LOG_LEVEL is missing']);
  });

  it('a capability absent from the declaration throws', () => {
    const partial: CapabilityDeclaration = { ...decl, keys: { ...decl.keys } };
    delete partial.keys.cookieDomain;
    expect(violationsOf('R3-dev-overlay', {}, partial)).toEqual([
      'cookieDomain: no config key in the declaration',
    ]);
  });

  it('an unknown outbound key is an error', () => {
    const v = violationsOf('R3-dev-overlay', {
      OUTBOUND: 'clever=live,lake-export=live,stripe=live',
    });
    expect(v.join()).toMatch(/outbound\.stripe is not declared/);
  });

  it('a declared outbound integration must be configured', () => {
    expect(violationsOf('R3-dev-overlay', { OUTBOUND: 'clever=live' }).join()).toMatch(
      /outbound\.lake-export is declared but not configured/
    );
  });

  it('lists ALL violations in one error', () => {
    const v = violationsOf('R1-prod', {
      FAIL_FAST: 'false',
      CRED: 'static',
      MAIL: 'stub',
      PERIMETER: 'on',
      PERMISSIVE: 'true',
      LOG_LEVEL: undefined,
    });
    for (const name of [
      'failFast',
      'credentialSource',
      'mailSink',
      'devPerimeter',
      'permissiveAuthz',
      'logLevel',
    ]) {
      expect(v.some(line => line.includes(name))).toBe(true);
    }
    expect(v.length).toBeGreaterThanOrEqual(6);
  });

  it('never puts config VALUES in the message', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE/wJalrXUtnFEMI-secret';
    const values = {
      CRED: secret,
      TLS: secret,
      FAIL_FAST: secret,
      MAIL: secret,
      CORS: `https://${secret}.example.org,http://localhost`,
      COOKIE: ' ',
      HOPS: secret,
      TELEMETRY: secret,
      PERIMETER: secret,
      PERMISSIVE: secret,
      LOG_FORMAT: ' ',
      LOG_LEVEL: ' ',
      OUTBOUND: `${secret},clever=${secret},${secret}=live`,
    };
    for (const row of rows) {
      let message = '';
      try {
        createEnv(decl, identityFor(row), source(values));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('invariant violations');
      expect(message).not.toContain('AKIA');
      expect(message).not.toContain('wJalr');
      expect(message).not.toContain('secret');
    }
    const dev = violationsOf('R1-prod', { CORS: 'https://dash.wootdev.com' }).join();
    expect(dev).not.toContain('wootdev');
  });
});

describe('testEnv', () => {
  it('returns R4-local capabilities with dev bindings, frozen', () => {
    const caps = testEnv();
    expect(Object.isFrozen(caps)).toBe(true);
    expect(caps).toMatchObject({
      credentialSource: 'static',
      mailSink: 'stub',
      telemetryEnv: 'dev',
      permissiveAuthz: false,
    });
  });

  it('is a valid R4 capability set and applies overrides', () => {
    expect(testEnv({ credentialSource: 'iam-token' }).credentialSource).toBe('iam-token');
    expect(testEnv({ outbound: { clever: 'off' } }).outbound).toEqual({ clever: 'off' });
  });
});

describe('loadEnv', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));

  it('builds capabilities from injected vars and resolver', async () => {
    const caps = await loadEnv(decl, source(validConfig['R2-lane'] as Record<string, string>), {
      vars: { EXEC_ENV: 'prod', LANE: 'twin' },
      resolver: async () => DEV_ACCOUNT_ID,
    });
    expect(caps.mailSink).toBe('capture');
  });

  it('builds local capabilities under SAGA_LOCAL=1', async () => {
    const caps = await loadEnv(decl, source(validConfig['R4-local'] as Record<string, string>), {
      vars: { SAGA_LOCAL: '1' },
    });
    expect(caps.credentialSource).toBe('static');
  });

  it('fails boot when the account is unresolved', async () => {
    await expect(loadEnv(decl, source({}), { vars: {} })).rejects.toThrow(/could not be resolved/);
  });

  it('loadEnv is the only process.env reader in the library; no module-top-level env reads', () => {
    const sources = readdirSync(path.join(dir, '..'), { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts') && !f.includes('__tests__') && f !== 'eslint/ratchet-cli.ts')
      .map(f => [f, readFileSync(path.join(dir, '..', f), 'utf8')] as const);
    expect(sources.filter(([, text]) => /process\.env/.test(text)).map(([f]) => f)).toEqual([
      'load.ts',
    ]);
    const load = (sources.find(([f]) => f === 'load.ts') as readonly [string, string])[1];
    expect(load.split('\n').filter(l => /process\.env/.test(l) && !/^(\s|\/\*)/.test(l))).toEqual(
      []
    );
  });
});
