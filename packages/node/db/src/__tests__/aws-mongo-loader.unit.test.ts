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

describe('loadMongoConfigFromAws — coords form', () => {
  function mockShared(ssmPrefix: string, secretPrefix: string): void {
    ssmMock
      .on(GetParameterCommand, { Name: `${ssmPrefix}/mongodb-hosts` })
      .resolves({ Parameter: { Value: 'h1:27017,h2:27017' } })
      .on(GetParameterCommand, { Name: `${ssmPrefix}/mongodb-replica-set-name` })
      .resolves({ Parameter: { Value: 'saga-rs' } })
      .on(GetParameterCommand, { Name: `${ssmPrefix}/mongodb-ca-secret-arn` })
      .resolves({ Parameter: { Value: 'arn:ca' } });
    smMock
      .on(GetSecretValueCommand, { SecretId: 'arn:ca' })
      .resolves({ SecretString: JSON.stringify({ ca_cert: 'CA-PEM' }) })
      .on(GetSecretValueCommand, { SecretId: `${secretPrefix}/ledger-api-password` })
      .resolves({ SecretString: JSON.stringify({ username: 'ledger_api_app', password: 'pw' }) });
  }

  it('shared coords read exactly the given prefixes', async () => {
    mockShared('/twin/mongo', 'twin/mongodb-shared');
    const config = await loadMongoConfigFromAws({
      coords: { kind: 'shared', ssmPrefix: '/twin/mongo', secretPrefix: 'twin/mongodb-shared' },
      project: 'ledger-api',
      instanceName: 'i',
    });
    expect(config).toMatchObject({
      hosts: ['h1:27017', 'h2:27017'],
      database: 'ledger_api_db',
      username: 'ledger_api_app',
      authSource: 'ledger_api_db',
      tlsCAContent: 'CA-PEM',
    });
    const names = ssmMock.commandCalls(GetParameterCommand).map((c) => c.args[0].input.Name);
    expect(names.every((n) => n?.startsWith('/twin/mongo/'))).toBe(true);
    const secrets = smMock.commandCalls(GetSecretValueCommand).map((c) => c.args[0].input.SecretId);
    expect(secrets).toContain('twin/mongodb-shared/ledger-api-password');
  });

  it('mirror-current coords reach the admin path', async () => {
    ssmMock.on(GetParameterCommand).callsFake(({ Name }) => ({
      Parameter: { Value: Name.endsWith('arn') ? 'arn:x' : 'v' },
    }));
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ ca_cert: 'CA', username: 'saga_admin', password: 'm' }),
    });
    const config = await loadMongoConfigFromAws({
      coords: { kind: 'mirror-current' },
      project: 'ledger-api',
      instanceName: 'i',
    });
    expect(config).toMatchObject({ username: 'saga_admin', authSource: 'admin' });
  });

  it('mirror-project coords read the per-project mirror secret', async () => {
    ssmMock.on(GetParameterCommand).callsFake(({ Name }) => ({
      Parameter: { Value: Name.endsWith('arn') ? 'arn:x' : 'v' },
    }));
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ ca_cert: 'CA', username: 'ledger_api_app', password: 'p' }),
    });
    await loadMongoConfigFromAws({
      coords: { kind: 'mirror-project' },
      project: 'ledger-api',
      instanceName: 'i',
    });
    const secrets = smMock.commandCalls(GetSecretValueCommand).map((c) => c.args[0].input.SecretId);
    expect(secrets).toContain('/mirror/current/ledger-api-mongo-password');
  });

  it('coords combined with env throws', async () => {
    await expect(
      loadMongoConfigFromAws({
        coords: { kind: 'mirror-current' },
        env: 'prod',
        project: 'p',
        instanceName: 'i',
      }),
    ).rejects.toThrow(/cannot be combined/);
  });
});

describe('loadMongoConfigFromAws — legacy env', () => {
  it('env=prod resolves /shared/infra/prod + prod/mongodb-shared and warns once', async () => {
    vi.resetModules();
    const mod = await import('../aws-mongo-loader.js');
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-hosts' })
      .resolves({ Parameter: { Value: 'h1:27017' } })
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-replica-set-name' })
      .resolves({ Parameter: { Value: 'saga-rs' } })
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-ca-secret-arn' })
      .resolves({ Parameter: { Value: 'arn:ca' } });
    smMock
      .on(GetSecretValueCommand, { SecretId: 'arn:ca' })
      .resolves({ SecretString: JSON.stringify({ ca_cert: 'CA' }) })
      .on(GetSecretValueCommand, { SecretId: 'prod/mongodb-shared/ledger-api-password' })
      .resolves({ SecretString: JSON.stringify({ username: 'u', password: 'pw' }) });
    const p = { scope: 'shared', env: 'prod', project: 'ledger-api', instanceName: 'i' } as const;
    const config = await mod.loadMongoConfigFromAws(p);
    await mod.loadMongoConfigFromAws(p);
    expect(config.hosts).toEqual(['h1:27017']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      type: 'DeprecationWarning',
      code: 'SOA_ENV_FALLBACK_MONGO_ENV',
    });
    warn.mockRestore();
  });
});
