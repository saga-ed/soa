import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  loadPostgresConfigFromAws,
  iamHostSsmPath,
  iamPortSsmPath,
  devSecretName,
} from '../aws-postgres-loader.js';

const smMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  smMock.reset();
  ssmMock.reset();
});

describe('path helpers', () => {
  it('iamHostSsmPath: mirror uses /mirror/current/*, prod uses /shared/infra/prod/*', () => {
    expect(iamHostSsmPath('mirror')).toBe('/mirror/current/postgres-rds/endpoint');
    expect(iamHostSsmPath('prod')).toBe('/shared/infra/prod/postgres-host');
  });

  it('iamPortSsmPath: same split by env', () => {
    expect(iamPortSsmPath('mirror')).toBe('/mirror/current/postgres-rds/port');
    expect(iamPortSsmPath('prod')).toBe('/shared/infra/prod/postgres-port');
  });

  it('devSecretName: nests role under service (single-DB)', () => {
    expect(devSecretName('chat-api', 'app')).toBe('dev/postgres-shared/chat-api/app');
    expect(devSecretName('chat-api', 'owner')).toBe('dev/postgres-shared/chat-api/owner');
    expect(devSecretName('chat-api', 'ro')).toBe('dev/postgres-shared/chat-api/ro');
  });

  it('devSecretName: nests dbId between service and role (multi-DB)', () => {
    expect(devSecretName('iam-api', 'owner', 'pii')).toBe(
      'dev/postgres-shared/iam-api/pii/owner',
    );
  });
});

describe('loadPostgresConfigFromAws — prod (IAM auth)', () => {
  it('reads coords from SSM and returns config with async password callback', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-host' })
      .resolves({ Parameter: { Value: 'saga-postgres-prod.rds.amazonaws.com' } })
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-port' })
      .resolves({ Parameter: { Value: '5432' } });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'chat-api',
      role: 'app',
      instanceName: 'ChatDB-prod',
    });

    expect(config.host).toBe('saga-postgres-prod.rds.amazonaws.com');
    expect(config.port).toBe(5432);
    expect(config.database).toBe('chat_api');
    expect(config.user).toBe('chat_api_app');
    expect(config.ssl).toBe(true);
    expect(typeof config.password).toBe('function');
  });

  it("defaults role to 'app' when omitted", async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: '5432' } });
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-host' })
      .resolves({ Parameter: { Value: 'h' } });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'chat-api',
      instanceName: 'i',
    });

    expect(config.user).toBe('chat_api_app');
  });

  it('uses owner role for AppInfra / migration workloads', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: '5432' } });
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-host' })
      .resolves({ Parameter: { Value: 'h' } });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'chat-api',
      role: 'owner',
      instanceName: 'i',
    });

    expect(config.user).toBe('chat_api_owner');
  });

  it('uses ro role for read-only workloads', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: '5432' } });
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-host' })
      .resolves({ Parameter: { Value: 'h' } });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'chat-api',
      role: 'ro',
      instanceName: 'i',
    });

    expect(config.user).toBe('chat_api_ro');
  });

  it('multi-DB: dbId nests into the derived database name', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: '5432' } });
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-host' })
      .resolves({ Parameter: { Value: 'h' } });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'iam-api',
      role: 'app',
      dbId: 'pii',
      instanceName: 'iam-pii',
    });

    expect(config.database).toBe('iam_api_pii_db');
    expect(config.user).toBe('iam_api_app');
  });

  it('username and database can be explicitly overridden', async () => {
    ssmMock
      .on(GetParameterCommand)
      .resolves({ Parameter: { Value: '5432' } });
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/postgres-host' })
      .resolves({ Parameter: { Value: 'h' } });

    const config = await loadPostgresConfigFromAws({
      env: 'prod',
      service: 'sds-api',
      role: 'app',
      username: 'ledger_writer',         // legacy override
      database: 'ledger',
      instanceName: 'i',
    });

    expect(config.user).toBe('ledger_writer');
    expect(config.database).toBe('ledger');
  });
});

describe('loadPostgresConfigFromAws — mirror (IAM auth, dev account)', () => {
  it('reads coords from /mirror/current/* SSM paths', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/mirror/current/postgres-rds/endpoint' })
      .resolves({ Parameter: { Value: 'mirror-pg.dev.internal' } })
      .on(GetParameterCommand, { Name: '/mirror/current/postgres-rds/port' })
      .resolves({ Parameter: { Value: '5432' } });

    const config = await loadPostgresConfigFromAws({
      env: 'mirror',
      service: 'chat-api',
      role: 'app',
      instanceName: 'ChatDB-mirror',
    });

    expect(config.host).toBe('mirror-pg.dev.internal');
    expect(config.port).toBe(5432);
    expect(config.user).toBe('chat_api_app');
    expect(config.ssl).toBe(true);
    expect(typeof config.password).toBe('function');
  });
});

describe('loadPostgresConfigFromAws — dev (static password from parity secret)', () => {
  it('reads the per-role parity secret and returns config with static password', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'dev/postgres-shared/chat-api/app',
      })
      .resolves({
        SecretString: JSON.stringify({
          username: 'chat_api_app',
          password: 'dev-password-chat-api',
          host: 'db-host.dbs',
          port: 5432,
          database: 'chat_api',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'dev',
      service: 'chat-api',
      role: 'app',
      instanceName: 'ChatDB-dev',
    });

    expect(config.host).toBe('db-host.dbs');
    expect(config.user).toBe('chat_api_app');
    expect(config.password).toBe('dev-password-chat-api');
    expect(config.ssl).toBe(false);
  });

  it('accepts dbname as an alternate field (mirror-workflow legacy compat)', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'dev/postgres-shared/sds-api/ro',
      })
      .resolves({
        SecretString: JSON.stringify({
          password: 'dev-password-sds-api',
          host: 'db-host.dbs',
          port: '5432',
          dbname: 'sds_api',
        }),
      });

    const config = await loadPostgresConfigFromAws({
      env: 'dev',
      service: 'sds-api',
      role: 'ro',
      instanceName: 'i',
    });

    expect(config.database).toBe('sds_api');
    expect(config.port).toBe(5432);
    expect(config.user).toBe('sds_api_ro');   // derived; secret had no username field
  });

  it('throws when the dev parity secret is missing', async () => {
    smMock
      .on(GetSecretValueCommand)
      .resolves({});

    await expect(
      loadPostgresConfigFromAws({
        env: 'dev',
        service: 'chat-api',
        role: 'app',
        instanceName: 'i',
      }),
    ).rejects.toThrow(/no SecretString/);
  });
});
