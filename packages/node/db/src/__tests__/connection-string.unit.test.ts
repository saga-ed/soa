import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MongoProvider } from '../mongo-provider.js';
import type { MongoProviderConfig } from '../mongo-provider-config.js';

const baseConfig = {
  configType: 'MONGO' as const,
  instanceName: 'test',
  hosts: ['db-host.example:27017'],
  database: 'app_db',
};

function uri(config: MongoProviderConfig): string {
  // The builder is instance-private but the inner method is intentionally
  // _public-prefixed for test access. Use the inner method directly so we
  // exercise URI assembly without instantiating MongoClient (which would try
  // to resolve DNS).
  const provider = new MongoProvider(config);
  return provider._buildConnectionString();
}

describe('MongoProvider._buildConnectionString', () => {
  it('builds a single-host no-auth no-tls URI', () => {
    expect(uri(baseConfig)).toBe('mongodb://db-host.example:27017/app_db');
  });

  it('encodes username and password', () => {
    expect(uri({
      ...baseConfig,
      username: 'user@with/special',
      password: 'p@ss/word',
    })).toBe(
      'mongodb://user%40with%2Fspecial:p%40ss%2Fword@db-host.example:27017/app_db',
    );
  });

  it('joins multiple hosts with commas (replica-set seed list)', () => {
    expect(uri({
      ...baseConfig,
      hosts: ['a.compute.internal:27017', 'b.compute.internal:27017', 'c.compute.internal:27017'],
      replicaSet: 'saga-rs',
    })).toBe(
      'mongodb://a.compute.internal:27017,b.compute.internal:27017,c.compute.internal:27017/app_db?replicaSet=saga-rs',
    );
  });

  it('appends authSource when set', () => {
    expect(uri({
      ...baseConfig,
      username: 'ledger_api_app',
      password: 'pw',
      authSource: 'ledger_api_db',
    })).toBe(
      'mongodb://ledger_api_app:pw@db-host.example:27017/app_db?authSource=ledger_api_db',
    );
  });

  it('appends tls=true and retryWrites=true when tls is enabled', () => {
    const u = uri({ ...baseConfig, tls: true });
    expect(u).toContain('tls=true');
    expect(u).toContain('retryWrites=true');
  });

  it('adds tlsCAFile to the URI when caller supplies a path', () => {
    const u = uri({
      ...baseConfig,
      tls: true,
      tlsCAFile: '/etc/ssl/saga-ca.pem',
    });
    expect(u).toContain('tlsCAFile=%2Fetc%2Fssl%2Fsaga-ca.pem');
  });

  it('does NOT add tls params when tls is false', () => {
    const u = uri({ ...baseConfig, tls: false });
    expect(u).not.toContain('tls=');
  });

  it('combines RS + TLS + SCRAM into one URI (canonical staging shape)', () => {
    const u = uri({
      configType: 'MONGO',
      instanceName: 'staging',
      hosts: ['ip-10-1-1-10.us-west-2.compute.internal:27017'],
      database: 'ledger_api_db',
      username: 'ledger_api_app',
      password: 'sekret',
      replicaSet: 'saga-rs',
      authSource: 'ledger_api_db',
      tls: true,
      tlsCAFile: '/tmp/ca.pem',
    });
    expect(u).toBe(
      'mongodb://ledger_api_app:sekret@ip-10-1-1-10.us-west-2.compute.internal:27017/ledger_api_db' +
        '?replicaSet=saga-rs&authSource=ledger_api_db&tls=true&retryWrites=true&tlsCAFile=%2Ftmp%2Fca.pem',
    );
  });

  it('rejects setting both tlsCAFile and tlsCAContent', () => {
    expect(() => new MongoProvider({
      ...baseConfig,
      tls: true,
      tlsCAFile: '/p',
      tlsCAContent: 'PEM',
    })).toThrow(/pick one/);
  });

  it('writes tlsCAContent to a tmp file and references it via tlsCAFile', () => {
    const provider = new MongoProvider({
      ...baseConfig,
      instanceName: 'cert-from-content-test',
      tls: true,
      tlsCAContent: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n',
    });
    const u = provider._buildConnectionString();
    // The tlsCAFile parameter is URL-encoded, so we URL-decode the URI's
    // query before checking the path shape.
    const queryString = u.split('?')[1] ?? '';
    const params = new URLSearchParams(queryString);
    const caFile = params.get('tlsCAFile');
    expect(caFile).toMatch(/saga-mongodb-ca-cert-from-content-test\.pem$/);
  });
});
