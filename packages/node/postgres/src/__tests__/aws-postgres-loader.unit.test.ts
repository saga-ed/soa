import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  loadPostgresConfigFromAws,
  postgresServiceSecretName,
} from '../aws-postgres-loader.js';

const smMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  smMock.reset();
});

describe('postgresServiceSecretName', () => {
  it('uses workflow path shape for mirror (leading slash, -postgres-password suffix)', () => {
    expect(postgresServiceSecretName('mirror', 'sds-api')).toBe(
      '/mirror/current/sds-api-postgres-password',
    );
  });

  it('inserts dbId before -postgres-password for multi-DB mirror', () => {
    expect(postgresServiceSecretName('mirror', 'iam-api', 'pii')).toBe(
      '/mirror/current/iam-api-pii-postgres-password',
    );
    expect(postgresServiceSecretName('mirror', 'iam-api', 'main')).toBe(
      '/mirror/current/iam-api-main-postgres-password',
    );
  });

  it('uses prod/postgres-shared/{service} for prod single-DB', () => {
    expect(postgresServiceSecretName('prod', 'sds-api')).toBe(
      'prod/postgres-shared/sds-api',
    );
  });

  it('appends -{dbId} for prod multi-DB', () => {
    expect(postgresServiceSecretName('prod', 'iam-api', 'main')).toBe(
      'prod/postgres-shared/iam-api-main',
    );
    expect(postgresServiceSecretName('prod', 'iam-api', 'pii')).toBe(
      'prod/postgres-shared/iam-api-pii',
    );
  });
});

describe('loadPostgresConfigFromAws', () => {
  it('reads mirror from the workflow path with SSL=true', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: '/mirror/current/sds-api-postgres-password',
      })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds_api_app',
          password: 'pw-from-mirror',
          host: 'saga-postgres-mirror.rds.amazonaws.com',
          port: 5432,
          dbname: 'sds_api', // mirror workflow uses 'dbname'
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
      database: 'sds_api',
      username: 'sds_api_app',
      password: 'pw-from-mirror',
      ssl: true,
    });
  });

  it('reads prod from prod/postgres-shared/{service} with SSL=true', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'prod/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds_api_app',
          password: 'pw',
          host: 'saga-postgres-prod.rds.amazonaws.com',
          port: 5432,
          database: 'sds_api',
          engine: 'postgres',
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
          username: 'sds_api_app',
          password: 'dev-password-sds-api',
          host: 'db-host.dbs',
          port: 5432,
          database: 'sds_api',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'dev',
      service: 'sds-api',
      instanceName: 'sds-dev',
    });

    expect(config.ssl).toBe(false);
  });

  it('supports multi-DB via dbId — rostering iam-api PII isolation', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'prod/postgres-shared/iam-api-pii',
      })
      .resolves({
        SecretString: JSON.stringify({
          username: 'iam_api_pii_app',
          password: 'pw',
          host: 'h',
          port: 5432,
          database: 'iam_pii_db',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'iam-api',
      dbId: 'pii',
      instanceName: 'iam-pii',
    });

    expect(config.database).toBe('iam_pii_db');
    expect(config.username).toBe('iam_api_pii_app');
  });

  it('accepts dbname (mirror workflow) or database (CLI) interchangeably', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'prod/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'u',
          password: 'p',
          host: 'h',
          port: 5432,
          database: 'd_from_database_field',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'sds-api',
      instanceName: 'i',
    });

    expect(config.database).toBe('d_from_database_field');
  });

  it('accepts string ports for SM payloads serialized that way', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: '/mirror/current/sds-api-postgres-password',
      })
      .resolves({
        SecretString: JSON.stringify({
          username: 'u',
          password: 'p',
          host: 'h',
          port: '5432',
          dbname: 'd',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'mirror',
      service: 'sds-api',
      instanceName: 'i',
    });

    expect(config.port).toBe(5432);
  });

  it('throws when both database and dbname are missing', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'prod/postgres-shared/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'u',
          password: 'p',
          host: 'h',
          port: 5432,
        }),
      });

    await expect(
      loadPostgresConfigFromAws({
        env: 'prod',
        service: 'sds-api',
        instanceName: 'i',
      }),
    ).rejects.toThrow(/missing both 'database' and 'dbname'/);
  });

  it('throws when the secret is missing', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: '/mirror/current/sds-api-postgres-password',
      })
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
