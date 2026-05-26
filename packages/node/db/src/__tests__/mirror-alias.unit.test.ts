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
 * The plan locks `mirror` as the canonical env name for all engines, with
 * `staging` kept as a deprecated alias for one cycle. Both names resolve
 * to the same underlying SSM/secret paths today because the IaC rename
 * hasn't shipped yet; when it does, this test will be updated to point
 * mirror at /shared/infra/mirror/* and the staging path will be removed.
 */

function stubStagingPaths() {
  ssmMock
    .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-hosts' })
    .resolves({ Parameter: { Value: 'h1:27017' } })
    .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-replica-set-name' })
    .resolves({ Parameter: { Value: 'saga-rs' } })
    .on(GetParameterCommand, { Name: '/shared/infra/staging/mongodb-ca-secret-arn' })
    .resolves({ Parameter: { Value: 'arn:ca' } });
  smMock
    .on(GetSecretValueCommand, { SecretId: 'arn:ca' })
    .resolves({ SecretString: JSON.stringify({ ca_cert: 'CA' }) })
    .on(GetSecretValueCommand, { SecretId: 'staging/mongodb-shared/sds-api-password' })
    .resolves({ SecretString: JSON.stringify({ username: 'sds_app', password: 'pw' }) });
}

describe("env='mirror' alias", () => {
  it("resolves env='mirror' against the staging SSM/secret paths", async () => {
    stubStagingPaths();

    const config = await loadMongoConfigFromAws({
      scope: 'shared',
      env: 'mirror',
      project: 'sds-api',
      instanceName: 'sds-mirror',
    });

    expect(config.username).toBe('sds_app');
    expect(config.hosts).toEqual(['h1:27017']);
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

  it("env='prod' is unaffected and uses /shared/infra/prod/* paths", async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-hosts' })
      .resolves({ Parameter: { Value: 'p1:27017' } })
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-replica-set-name' })
      .resolves({ Parameter: { Value: 'saga-rs' } })
      .on(GetParameterCommand, { Name: '/shared/infra/prod/mongodb-ca-secret-arn' })
      .resolves({ Parameter: { Value: 'arn:prod-ca' } });
    smMock
      .on(GetSecretValueCommand, { SecretId: 'arn:prod-ca' })
      .resolves({ SecretString: JSON.stringify({ ca_cert: 'PROD-CA' }) })
      .on(GetSecretValueCommand, { SecretId: 'prod/mongodb-shared/sds-api-password' })
      .resolves({ SecretString: JSON.stringify({ username: 'sds_app', password: 'pw' }) });

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
