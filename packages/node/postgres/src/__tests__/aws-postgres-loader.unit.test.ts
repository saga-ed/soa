import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { loadPostgresConfigFromAws } from '../aws-postgres-loader.js';

const smMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  smMock.reset();
});

describe('loadPostgresConfigFromAws', () => {
  it('reads from the canonical {env}/postgres-shared/{service} path for mirror', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'mirror/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds_mirror',
          password: 'pw-from-sm',
          host: 'saga-postgres-mirror.rds.amazonaws.com',
          port: 5432,
          database: 'sds',
          engine: 'postgres',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'mirror',
      service: 'sds-api',
      instanceName: 'sds-mirror',
    });

    expect(config).toMatchObject({
      configType: 'POSTGRES',
      instanceName: 'sds-mirror',
      host: 'saga-postgres-mirror.rds.amazonaws.com',
      port: 5432,
      database: 'sds',
      username: 'sds_mirror',
      password: 'pw-from-sm',
      ssl: true, // mirror is managed RDS — SSL required
    });
  });

  it('reads from prod path with ssl=true', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'prod/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds_prod',
          password: 'pw',
          host: 'saga-postgres-prod.rds.amazonaws.com',
          port: 5432,
          database: 'sds',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'sds-api',
      instanceName: 'sds-prod',
    });

    expect(config.ssl).toBe(true);
    expect(config.host).toBe('saga-postgres-prod.rds.amazonaws.com');
  });

  it('disables SSL for dev (db-host has no TLS)', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'dev/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds_dev',
          password: 'dev-password-sds-api',
          host: 'db-host.dbs',
          port: 5432,
          database: 'sds',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'dev',
      service: 'sds-api',
      instanceName: 'sds-dev',
    });

    expect(config.ssl).toBe(false);
  });

  it('accepts string ports for SM payloads serialized that way', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'mirror/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'u',
          password: 'p',
          host: 'h',
          port: '5432',
          database: 'd',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'mirror',
      service: 'sds-api',
      instanceName: 'i',
    });

    expect(config.port).toBe(5432);
  });

  it('throws when the secret is missing', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'mirror/postgres-shared/sds-api' })
      .resolves({});

    await expect(
      loadPostgresConfigFromAws({
        env: 'mirror',
        service: 'sds-api',
        instanceName: 'i',
      }),
    ).rejects.toThrow(/no SecretString/);
  });
});
