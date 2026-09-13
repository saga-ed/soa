import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SALT_SECRET_ID, loadSalt } from '../salt.js';

function stubClient(secretString: string | undefined) {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  const client = { send } as unknown as SecretsManagerClient;
  return { client, send };
}

describe('loadSalt precedence', () => {
  it('prefers an explicit opts.salt over env and Secrets Manager', async () => {
    const { client, send } = stubClient('from-secrets-manager');
    const salt = await loadSalt({
      salt: 'explicit-salt',
      client,
      env: { LAKE_SALT: 'from-env' },
    });
    expect(salt).toBe('explicit-salt');
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to env.LAKE_SALT (local/dev/test) when no explicit salt is given', async () => {
    const { client, send } = stubClient('from-secrets-manager');
    const salt = await loadSalt({ client, env: { LAKE_SALT: 'from-env' } });
    expect(salt).toBe('from-env');
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to Secrets Manager on the default secret id when no salt/env value is given', async () => {
    const { client, send } = stubClient('from-secrets-manager');
    const salt = await loadSalt({ client, env: {} });
    expect(salt).toBe('from-secrets-manager');
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0] as GetSecretValueCommand;
    expect(cmd).toBeInstanceOf(GetSecretValueCommand);
    expect(cmd.input.SecretId).toBe(DEFAULT_SALT_SECRET_ID);
  });

  it('uses env.LAKE_SALT_SECRET_ID when set and no explicit secretId is given', async () => {
    const { client, send } = stubClient('from-secrets-manager');
    await loadSalt({ client, env: { LAKE_SALT_SECRET_ID: 'custom/secret/id' } });
    const cmd = send.mock.calls[0]?.[0] as GetSecretValueCommand;
    expect(cmd.input.SecretId).toBe('custom/secret/id');
  });

  it('opts.secretId takes precedence over env.LAKE_SALT_SECRET_ID', async () => {
    const { client, send } = stubClient('from-secrets-manager');
    await loadSalt({
      client,
      secretId: 'explicit/secret/id',
      env: { LAKE_SALT_SECRET_ID: 'custom/secret/id' },
    });
    const cmd = send.mock.calls[0]?.[0] as GetSecretValueCommand;
    expect(cmd.input.SecretId).toBe('explicit/secret/id');
  });

  it('throws when the resolved secret has no SecretString, without leaking any value', async () => {
    const { client } = stubClient(undefined);
    await expect(loadSalt({ client, env: {} })).rejects.toThrow(/SecretString/);
  });
});
