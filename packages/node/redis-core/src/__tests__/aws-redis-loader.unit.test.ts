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
import { loadRedisConfigFromAws } from '../aws-redis-loader.js';

const smMock = mockClient(SecretsManagerClient);
const ssmMock = mockClient(SSMClient);

beforeEach(() => {
  smMock.reset();
  ssmMock.reset();
});

describe('loadRedisConfigFromAws', () => {
  it('reads endpoint from the secret when present', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'prod/redis/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds-api-prod',
          password: 'pw',
          endpoint: 'master.prod-redis.cache.amazonaws.com',
          port: 6379,
          tls: true,
          user_group_id: 'cache-prod',
        }),
      });

    const config = await loadRedisConfigFromAws({
      env: 'prod',
      service: 'sds-api',
    });

    expect(config).toEqual({
      url: 'master.prod-redis.cache.amazonaws.com',
      username: 'sds-api-prod',
      password: 'pw',
      tls: true,
    });
  });

  it('falls back to SSM /shared/infra/{env}/redis-endpoint when secret omits endpoint', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'mirror/redis/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds-api-mirror',
          password: 'pw',
        }),
      });

    ssmMock
      .on(GetParameterCommand, { Name: '/shared/infra/mirror/redis-endpoint' })
      .resolves({ Parameter: { Value: 'master.mirror-redis.cache.amazonaws.com' } });

    const config = await loadRedisConfigFromAws({
      env: 'mirror',
      service: 'sds-api',
    });

    expect(config.url).toBe('master.mirror-redis.cache.amazonaws.com');
    expect(config.tls).toBe(true); // default for non-dev
  });

  it('defaults tls=false for dev', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'dev/redis/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'sds-api-dev',
          password: 'dev-password-sds-api',
          endpoint: 'localhost',
        }),
      });

    const config = await loadRedisConfigFromAws({
      env: 'dev',
      service: 'sds-api',
    });

    expect(config.tls).toBe(false);
  });

  it('respects explicit tls=false from secret even on mirror/prod', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'mirror/redis/sds-api' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'u',
          password: 'p',
          endpoint: 'h',
          tls: false,
        }),
      });

    const config = await loadRedisConfigFromAws({
      env: 'mirror',
      service: 'sds-api',
    });

    expect(config.tls).toBe(false);
  });
});
