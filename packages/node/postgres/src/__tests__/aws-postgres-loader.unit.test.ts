import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('iamHostSsmPath: mirror uses /mirror/current/*, prod uses /prod/postgres-rds/*', () => {
    expect(iamHostSsmPath('mirror')).toBe('/mirror/current/postgres-rds/endpoint');
    expect(iamHostSsmPath('prod')).toBe('/prod/postgres-rds/endpoint');
  });

  it('iamPortSsmPath: same split by env', () => {
    expect(iamPortSsmPath('mirror')).toBe('/mirror/current/postgres-rds/port');
    expect(iamPortSsmPath('prod')).toBe('/prod/postgres-rds/port');
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
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/endpoint' })
      .resolves({ Parameter: { Value: 'saga-postgres-prod.rds.amazonaws.com' } })
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/port' })
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
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/endpoint' })
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
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/endpoint' })
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
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/endpoint' })
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
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/endpoint' })
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
      .on(GetParameterCommand, { Name: '/prod/postgres-rds/endpoint' })
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

describe('loadPostgresConfigFromAws — capability form', () => {
  const coords = {
    hostSsmPath: '/twin/pg/endpoint',
    portSsmPath: '/twin/pg/port',
  };
  const devSecret = {
    SecretString: JSON.stringify({
      password: 'pw',
      host: 'db-host.dbs',
      port: 5432,
      database: 'chat_api',
    }),
  };

  function caFile(): { path: string; pem: string } {
    const pem = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';
    const path = join(mkdtempSync(join(tmpdir(), 'pg-ca-')), 'ca.pem');
    writeFileSync(path, pem);
    return { path, pem };
  }

  it('iam-token without coords throws', async () => {
    await expect(
      loadPostgresConfigFromAws({
        credentialSource: 'iam-token',
        tls: { required: true },
        service: 'chat-api',
        instanceName: 'i',
      }),
    ).rejects.toThrow(/requires explicit 'coords'/);
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it('iam-token reads exactly the given SSM paths', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: coords.hostSsmPath })
      .resolves({ Parameter: { Value: 'twin-pg.dev.internal' } })
      .on(GetParameterCommand, { Name: coords.portSsmPath })
      .resolves({ Parameter: { Value: '5432' } });

    const config = await loadPostgresConfigFromAws({
      credentialSource: 'iam-token',
      coords,
      tls: { required: true },
      service: 'chat-api',
      instanceName: 'i',
    });

    expect(config.host).toBe('twin-pg.dev.internal');
    expect(config.ssl).toBe(true);
    expect(typeof config.password).toBe('function');
    const names = ssmMock.commandCalls(GetParameterCommand).map((c) => c.args[0].input.Name);
    expect(names.sort()).toEqual([coords.hostSsmPath, coords.portSsmPath].sort());
  });

  it('capability form without tls throws', async () => {
    await expect(
      // @ts-expect-error tls is required in the capability form
      loadPostgresConfigFromAws({ credentialSource: 'static', service: 'chat-api', instanceName: 'i' }),
    ).rejects.toThrow(/requires explicit 'tls'/);
  });

  it('static reads the dev parity secret; tls not required → ssl false', async () => {
    smMock.on(GetSecretValueCommand).resolves(devSecret);
    const config = await loadPostgresConfigFromAws({
      credentialSource: 'static',
      tls: { required: false },
      service: 'chat-api',
      instanceName: 'i',
    });
    expect(smMock.commandCalls(GetSecretValueCommand)[0]?.args[0].input.SecretId).toBe(
      'dev/postgres-shared/chat-api/app',
    );
    expect(config.password).toBe('pw');
    expect(config.ssl).toBe(false);
  });

  it('tls with caBundlePath yields a pinned ca object (iam-token)', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: '5432' } });
    const ca = caFile();
    const config = await loadPostgresConfigFromAws({
      credentialSource: 'iam-token',
      coords,
      tls: { required: true, caBundlePath: ca.path },
      service: 'chat-api',
      instanceName: 'i',
    });
    expect(config.ssl).toEqual({ ca: ca.pem, rejectUnauthorized: true });
  });

  it('tls with caBundlePath yields a pinned ca object (static)', async () => {
    smMock.on(GetSecretValueCommand).resolves(devSecret);
    const ca = caFile();
    const config = await loadPostgresConfigFromAws({
      credentialSource: 'static',
      tls: { required: true, caBundlePath: ca.path },
      service: 'chat-api',
      instanceName: 'i',
    });
    expect(config.ssl).toEqual({ ca: ca.pem, rejectUnauthorized: true });
  });

  it('tls required without CA -> true; not required -> false (both branches)', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: '5432' } });
    smMock.on(GetSecretValueCommand).resolves(devSecret);
    const base = { service: 'chat-api', instanceName: 'i' };
    expect(
      (await loadPostgresConfigFromAws({ ...base, credentialSource: 'static', tls: { required: true } })).ssl,
    ).toBe(true);
    expect(
      (await loadPostgresConfigFromAws({ ...base, credentialSource: 'iam-token', coords, tls: { required: false } })).ssl,
    ).toBe(false);
  });

  it('passing both env and credentialSource throws', async () => {
    await expect(
      loadPostgresConfigFromAws({
        env: 'prod',
        credentialSource: 'static',
        service: 'chat-api',
        instanceName: 'i',
      } as never),
    ).rejects.toThrow(/exactly one of/);
  });

  it('passing neither env nor credentialSource throws', async () => {
    await expect(
      loadPostgresConfigFromAws({ service: 'chat-api', instanceName: 'i' } as never),
    ).rejects.toThrow(/exactly one of/);
  });
});

describe('loadPostgresConfigFromAws — legacy env deprecation', () => {
  it('still works and emits the deprecation warning once per process', async () => {
    vi.resetModules();
    const mod = await import('../aws-postgres-loader.js');
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    smMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ password: 'pw', host: 'h', port: 5432 }),
    });
    const params = { env: 'dev', service: 'chat-api', instanceName: 'i' } as const;
    await mod.loadPostgresConfigFromAws(params);
    await mod.loadPostgresConfigFromAws(params);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      type: 'DeprecationWarning',
      code: 'SOA_ENV_FALLBACK_POSTGRES_ENV',
    });
    warn.mockRestore();
  });
});
