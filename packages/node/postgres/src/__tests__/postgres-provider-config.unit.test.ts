import { describe, it, expect } from 'vitest';
import { PostgresProviderSchema } from '../postgres-provider-config.js';

describe('PostgresProviderSchema', () => {
  it('accepts the minimal payload from saga-provision-credentials', () => {
    const config = PostgresProviderSchema.parse({
      instanceName: 'sds-mirror',
      host: 'rds.example.com',
      port: 5432,
      database: 'sds',
      username: 'sds_mirror',
      password: 'pw',
    });
    expect(config).toMatchObject({
      configType: 'POSTGRES',
      instanceName: 'sds-mirror',
      host: 'rds.example.com',
      port: 5432,
      database: 'sds',
      username: 'sds_mirror',
      password: 'pw',
      ssl: false,
      poolSize: 10,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 10_000,
      statementTimeoutMs: 0,
      lockTimeoutMs: 0,
      // Safety guard (gh-186) defaults ON, unlike the opt-in perf timeouts.
      idleInTransactionSessionTimeoutMs: 30_000,
    });
  });

  it('preserves pool tuning when provided', () => {
    const config = PostgresProviderSchema.parse({
      instanceName: 'sds-mirror',
      host: 'h',
      port: 5432,
      database: 'd',
      username: 'u',
      password: 'p',
      poolSize: 25,
      statementTimeoutMs: 5_000,
    });
    expect(config.poolSize).toBe(25);
    expect(config.statementTimeoutMs).toBe(5_000);
  });

  it('rejects missing required fields', () => {
    expect(() =>
      PostgresProviderSchema.parse({
        instanceName: 'x',
        host: '',
        port: 5432,
        database: 'd',
        username: 'u',
        password: 'p',
      }),
    ).toThrow();
  });

  it('rejects non-positive port', () => {
    expect(() =>
      PostgresProviderSchema.parse({
        instanceName: 'x',
        host: 'h',
        port: 0,
        database: 'd',
        username: 'u',
        password: 'p',
      }),
    ).toThrow();
  });
});
