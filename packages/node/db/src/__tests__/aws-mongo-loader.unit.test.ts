import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { loadMongoConfigFromAws } from '../aws-mongo-loader.js';

const ssmMock = mockClient(SSMClient);
const smMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  ssmMock.reset();
  smMock.reset();
});

describe('loadMongoConfigFromAws — scope=shared', () => {
  it('assembles a per-service config from staging SSM + Secrets', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-hosts' })
      .resolves({ Parameter: { Value: 'h1.compute.internal:27017,h2.compute.internal:27017' } })
      .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-replica-set-name' })
      .resolves({ Parameter: { Value: 'saga-rs' } })
      .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-ca-secret-arn' })
      .resolves({ Parameter: { Value: 'arn:aws:secretsmanager:us-west-2:111:secret:staging/mongodb-shared/ca-X' } });

    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'arn:aws:secretsmanager:us-west-2:111:secret:staging/mongodb-shared/ca-X',
      })
      .resolves({ SecretString: JSON.stringify({ ca_cert: '-----BEGIN CERT-----\nfake\n-----END CERT-----\n' }) })
      .on(GetSecretValueCommand, { SecretId: 'staging/mongodb-shared/ledger-api-password' })
      .resolves({ SecretString: JSON.stringify({ username: 'ledger_api_app', password: 'pw' }) });

    const config = await loadMongoConfigFromAws({
      scope: 'shared',
      env: 'staging',
      project: 'ledger-api',
      instanceName: 'staging-ledger',
    });

    expect(config).toMatchObject({
      configType: 'MONGO',
      instanceName: 'staging-ledger',
      hosts: ['h1.compute.internal:27017', 'h2.compute.internal:27017'],
      database: 'ledger_api_db',
      username: 'ledger_api_app',
      password: 'pw',
      replicaSet: 'saga-rs',
      authSource: 'ledger_api_db',
      tls: true,
    });
    expect(config.tlsCAContent).toContain('BEGIN CERT');
  });

  it('throws if scope=shared but env is missing', async () => {
    await expect(
      loadMongoConfigFromAws({
        scope: 'shared',
        project: 'ledger-api',
        instanceName: 'x',
      } as any),
    ).rejects.toThrow(/env/);
  });
});

describe('loadMongoConfigFromAws — scope=mirror-current', () => {
  it('assembles an admin config from mirror SSM + Secrets', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/mirror/current/mongodb-shared/endpoint' })
      .resolves({ Parameter: { Value: 'ip-10-3-1-1.us-west-2.compute.internal' } })
      .on(GetParameterCommand, { Name: '/mirror/current/mongodb-shared/port' })
      .resolves({ Parameter: { Value: '27017' } })
      .on(GetParameterCommand, { Name: '/mirror/current/mongodb-shared/replica-set-name' })
      .resolves({ Parameter: { Value: 'saga-rs' } })
      .on(GetParameterCommand, { Name: '/mirror/current/mongodb-shared/ca-secret-arn' })
      .resolves({ Parameter: { Value: 'arn:aws:secretsmanager:us-west-2:222:secret:staging/mongodb-shared/ca-Y' } })
      .on(GetParameterCommand, { Name: '/mirror/current/mongodb-shared/master-secret-arn' })
      .resolves({ Parameter: { Value: 'arn:aws:secretsmanager:us-west-2:222:secret:/mirror/current/mongodb-shared/master-Z' } });

    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'arn:aws:secretsmanager:us-west-2:222:secret:staging/mongodb-shared/ca-Y',
      })
      .resolves({ SecretString: JSON.stringify({ ca_cert: 'CA-PEM' }) })
      .on(GetSecretValueCommand, {
        SecretId: 'arn:aws:secretsmanager:us-west-2:222:secret:/mirror/current/mongodb-shared/master-Z',
      })
      .resolves({ SecretString: JSON.stringify({ username: 'saga_admin', password: 'master-pw' }) });

    const config = await loadMongoConfigFromAws({
      scope: 'mirror-current',
      project: 'ledger-api',
      instanceName: 'mirror-ledger',
    });

    expect(config).toMatchObject({
      configType: 'MONGO',
      instanceName: 'mirror-ledger',
      hosts: ['ip-10-3-1-1.us-west-2.compute.internal:27017'],
      database: 'ledger_api_db',
      username: 'saga_admin',
      password: 'master-pw',
      replicaSet: 'saga-rs',
      authSource: 'admin',
      tls: true,
      tlsCAContent: 'CA-PEM',
    });
  });
});
