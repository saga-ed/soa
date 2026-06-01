import { describe, it, expect, beforeEach, vi } from 'vitest';
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

/**
 * Mirror reads from the existing refresh workflow's per-service paths:
 *   SSM:    /mirror/current/mongodb-shared/{endpoint,port,replica-set-name,ca-secret-arn}
 *   Secret: /mirror/current/{project}-mongo-password
 *
 * This unifies the daily refresh workflow's rotation and consumer reads
 * into a single source of truth instead of two parallel universes.
 *
 * The legacy ``env='staging'`` path is kept for one deprecation cycle —
 * resolves to /shared/infra/staging/* and staging/mongodb-shared/* with a
 * console.warn.
 */

function stubMirrorPaths() {
  ssmMock
    .on(GetParameterCommand, {
      Name: '/mirror/current/mongodb-shared/endpoint',
    })
    .resolves({ Parameter: { Value: 'mirror-mongo.dev.internal' } })
    .on(GetParameterCommand, { Name: '/mirror/current/mongodb-shared/port' })
    .resolves({ Parameter: { Value: '27017' } })
    .on(GetParameterCommand, {
      Name: '/mirror/current/mongodb-shared/replica-set-name',
    })
    .resolves({ Parameter: { Value: 'saga-rs' } })
    .on(GetParameterCommand, {
      Name: '/mirror/current/mongodb-shared/ca-secret-arn',
    })
    .resolves({ Parameter: { Value: 'arn:mirror-ca' } });
  smMock
    .on(GetSecretValueCommand, { SecretId: 'arn:mirror-ca' })
    .resolves({ SecretString: JSON.stringify({ ca_cert: 'MIRROR-CA' }) })
    .on(GetSecretValueCommand, {
      SecretId: '/mirror/current/sds-api-mongo-password',
    })
    .resolves({
      SecretString: JSON.stringify({
        username: 'sds_api_app',
        password: 'mirror-pw',
      }),
    });
}

function stubStagingPaths() {
  ssmMock
    .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-hosts' })
    .resolves({ Parameter: { Value: 'h1:27017' } })
    .on(GetParameterCommand, {
      Name: '/shared/infra/staging/mongodb-replica-set-name',
    })
    .resolves({ Parameter: { Value: 'saga-rs' } })
    .on(GetParameterCommand, {
      Name: '/shared/infra/staging/mongodb-ca-secret-arn',
    })
    .resolves({ Parameter: { Value: 'arn:ca' } });
  smMock
    .on(GetSecretValueCommand, { SecretId: 'arn:ca' })
    .resolves({ SecretString: JSON.stringify({ ca_cert: 'CA' }) })
    .on(GetSecretValueCommand, {
      SecretId: 'staging/mongodb-shared/sds-api-password',
    })
    .resolves({
      SecretString: JSON.stringify({ username: 'sds_app', password: 'pw' }),
    });
}

describe("env='mirror' reads from refresh workflow paths", () => {
  it('uses /mirror/current/* SSM + /mirror/current/{project}-mongo-password secret', async () => {
    stubMirrorPaths();

    const config = await loadMongoConfigFromAws({
      scope: 'shared',
      env: 'mirror',
      project: 'sds-api',
      instanceName: 'sds-mirror',
    });

    expect(config.username).toBe('sds_api_app');
    expect(config.password).toBe('mirror-pw');
    expect(config.hosts).toEqual(['mirror-mongo.dev.internal:27017']);
    expect(config.replicaSet).toBe('saga-rs');
    expect(config.authSource).toBe('sds_api_db');
    expect(config.tls).toBe(true);
    expect(config.tlsCAContent).toBe('MIRROR-CA');
  });

  it("env='staging' still works but emits a deprecation warning", async () => {
    stubStagingPaths();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await loadMongoConfigFromAws({
      scope: 'shared',
      env: 'staging',
      project: 'sds-api',
      instanceName: 'sds-staging',
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("env='staging' is deprecated"),
    );
    warn.mockRestore();
  });

  it("env='prod' uses /shared/infra/prod/* paths unchanged", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-hosts' })
      .resolves({ Parameter: { Value: 'p1:27017' } })
      .on(GetParameterCommand, {
        Name: '/shared/infra/prod/mongodb-replica-set-name',
      })
      .resolves({ Parameter: { Value: 'saga-rs' } })
      .on(GetParameterCommand, {
        Name: '/shared/infra/prod/mongodb-ca-secret-arn',
      })
      .resolves({ Parameter: { Value: 'arn:prod-ca' } });
    smMock
      .on(GetSecretValueCommand, { SecretId: 'arn:prod-ca' })
      .resolves({ SecretString: JSON.stringify({ ca_cert: 'PROD-CA' }) })
      .on(GetSecretValueCommand, {
        SecretId: 'prod/mongodb-shared/sds-api-password',
      })
      .resolves({
        SecretString: JSON.stringify({ username: 'sds_app', password: 'pw' }),
      });

    const config = await loadMongoConfigFromAws({
      scope: 'shared',
      env: 'prod',
      project: 'sds-api',
      instanceName: 'sds-prod',
    });

    expect(config.hosts).toEqual(['p1:27017']);
  });

  it('rejects unknown envs', async () => {
    await expect(
      loadMongoConfigFromAws({
        scope: 'shared',
        // @ts-expect-error — testing runtime validation of invalid env
        env: 'preprod',
        project: 'sds-api',
        instanceName: 'i',
      }),
    ).rejects.toThrow(/scope='shared'/);
  });
});
