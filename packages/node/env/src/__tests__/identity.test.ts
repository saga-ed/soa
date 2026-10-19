import { describe, expect, it, vi } from 'vitest';
import {
  EnvIdentityError,
  parseIdentity,
  parseLane,
  resolveAccount,
  type ResolvedAccount,
} from '../index.js';
import { DEV_ACCOUNT_ID, PROD_ACCOUNT_ID } from '../account.js';

const PROD: ResolvedAccount = { kind: 'prod', id: PROD_ACCOUNT_ID };
const DEV: ResolvedAccount = { kind: 'dev', id: DEV_ACCOUNT_ID };
const LOCAL: ResolvedAccount = { kind: 'local' };
const ML_SANDBOX = '579072312004';

const taskArn = (account: string) => `arn:aws:ecs:us-west-2:${account}:task/cluster/abc123`;
const ecsFetch = (account: string) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ TaskARN: taskArn(account) }) }));

describe('parseLane', () => {
  it.each([
    [{}, 'none'],
    [{ LANE: '' }, 'none'],
    [{ LANE: '   ' }, 'none'],
    [{ LANE: 'none' }, 'none'],
    [{ LANE: 'twin' }, 'twin'],
    [{ LANE: '  Twin ' }, 'twin'],
    [{ LANE: 'MIRROR' }, 'mirror'],
    [{ LANE: ' mIrRoR\n' }, 'mirror'],
  ])('%j -> %s', (vars, lane) => {
    expect(parseLane(vars)).toEqual({ lane });
  });

  it.each(['prod', 'twin2', 'tw in', '1', 'mirror,twin'])(
    'garbage %j is invalid and never throws',
    garbage => {
      const parsed = parseLane({ LANE: garbage });
      expect(parsed.lane).toBe('invalid');
      expect('reason' in parsed && parsed.reason.length > 0).toBe(true);
    }
  );

  it('ignores the EXEC_ENV=mirror alias', () => {
    expect(parseLane({ EXEC_ENV: 'mirror' })).toEqual({ lane: 'none' });
  });
});

describe('resolveAccount', () => {
  it('maps the ECS task ARN account to prod and dev', async () => {
    const uri = 'http://169.254.170.2/v4/abc';
    for (const [id, kind] of [
      [PROD_ACCOUNT_ID, 'prod'],
      [DEV_ACCOUNT_ID, 'dev'],
    ] as const) {
      const fetch = ecsFetch(id);
      await expect(
        resolveAccount({ ECS_CONTAINER_METADATA_URI_V4: uri }, undefined, { fetch })
      ).resolves.toEqual({ kind, id });
      expect(fetch).toHaveBeenCalledWith(
        `${uri}/task`,
        expect.objectContaining({ signal: expect.anything() })
      );
    }
  });

  it('throws for any other account id (ML sandbox must not map to dev)', async () => {
    const fetch = ecsFetch(ML_SANDBOX);
    await expect(
      resolveAccount({ ECS_CONTAINER_METADATA_URI_V4: 'http://x' }, undefined, { fetch })
    ).rejects.toThrow(EnvIdentityError);
    await expect(resolveAccount({}, async () => ML_SANDBOX)).rejects.toThrow(EnvIdentityError);
  });

  it('uses the injected resolver when there is no ECS endpoint', async () => {
    await expect(resolveAccount({}, async () => DEV_ACCOUNT_ID)).resolves.toEqual(DEV);
  });

  it('falls back to the resolver when the ECS lookup fails', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      resolveAccount({ ECS_CONTAINER_METADATA_URI_V4: 'http://x' }, async () => PROD_ACCOUNT_ID, {
        fetch,
      })
    ).resolves.toEqual(PROD);
  });

  it('times out a hung ECS lookup via the abort signal', async () => {
    const fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(
      resolveAccount({ ECS_CONTAINER_METADATA_URI_V4: 'http://x' }, undefined, {
        fetch,
        timeoutMs: 10,
      })
    ).rejects.toThrow(/could not be resolved/);
  });

  it.each([
    ['no source at all', {}, undefined],
    ['resolver returns undefined', {}, async () => undefined],
    [
      'resolver throws',
      {},
      async () => {
        throw new Error('sts down');
      },
    ],
    ['resolver malformed id', {}, async () => 'not-an-account'],
  ])('without SAGA_LOCAL, unresolved account throws: %s', async (_name, vars, resolver) => {
    await expect(resolveAccount(vars, resolver)).rejects.toThrow(EnvIdentityError);
  });

  it('rejects a malformed ECS response', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
    await expect(
      resolveAccount({ ECS_CONTAINER_METADATA_URI_V4: 'http://x' }, undefined, { fetch })
    ).rejects.toThrow(EnvIdentityError);
  });

  describe('SAGA_LOCAL=1', () => {
    it('is local with no resolver', async () => {
      await expect(resolveAccount({ SAGA_LOCAL: '1' })).resolves.toEqual({ kind: 'local' });
    });

    it.each([
      'ECS_CONTAINER_METADATA_URI',
      'ECS_CONTAINER_METADATA_URI_V4',
      'AWS_EXECUTION_ENV',
      'AWS_LAMBDA_FUNCTION_NAME',
    ])('is refused when %s is present on its own', async name => {
      await expect(resolveAccount({ SAGA_LOCAL: '1', [name]: 'x' })).rejects.toThrow(
        /SAGA_LOCAL=1 refused/
      );
    });

    it('resolver failure resolves to local', async () => {
      await expect(
        resolveAccount({ SAGA_LOCAL: '1' }, async () => {
          throw new Error('no creds');
        })
      ).resolves.toEqual({ kind: 'local' });
    });

    it('resolver with no result or a non-prod account resolves to local', async () => {
      await expect(resolveAccount({ SAGA_LOCAL: '1' }, async () => undefined)).resolves.toEqual({
        kind: 'local',
      });
      await expect(
        resolveAccount({ SAGA_LOCAL: '1' }, async () => DEV_ACCOUNT_ID)
      ).resolves.toEqual({ kind: 'local' });
    });

    it('resolver returning prod is refused', async () => {
      await expect(
        resolveAccount({ SAGA_LOCAL: '1' }, async () => PROD_ACCOUNT_ID)
      ).rejects.toThrow(/prod account/);
    });

    it('only the literal value 1 declares local', async () => {
      await expect(resolveAccount({ SAGA_LOCAL: 'true' })).rejects.toThrow(EnvIdentityError);
    });
  });
});

describe('parseIdentity: environment -> row mapping', () => {
  it.each([
    ['prod', { EXEC_ENV: 'prod', NODE_ENV: 'production' }, PROD, 'R1-prod', 'none'],
    [
      'twin lane',
      { EXEC_ENV: 'prod', NODE_ENV: 'production', LANE: 'twin' },
      DEV,
      'R2-lane',
      'twin',
    ],
    [
      'mirror lane',
      { EXEC_ENV: 'prod', NODE_ENV: 'production', LANE: 'mirror' },
      DEV,
      'R2-lane',
      'mirror',
    ],
    [
      'dev-main (legacy EXEC_ENV=dev)',
      { EXEC_ENV: 'dev', NODE_ENV: 'development' },
      DEV,
      'R3-dev-overlay',
      'none',
    ],
    [
      'dev-main after flip',
      { EXEC_ENV: 'prod', NODE_ENV: 'production' },
      DEV,
      'R3-dev-overlay',
      'none',
    ],
    [
      'container-per-PR preview',
      { EXEC_ENV: 'dev', NODE_ENV: 'development' },
      DEV,
      'R3-dev-overlay',
      'none',
    ],
    ['training', { EXEC_ENV: 'dev', NODE_ENV: 'development' }, DEV, 'R3-dev-overlay', 'none'],
    ['saga-sandbox', { EXEC_ENV: 'dev', NODE_ENV: 'development' }, DEV, 'R3-dev-overlay', 'none'],
    ['/ss', { SAGA_LOCAL: '1', NODE_ENV: 'development' }, LOCAL, 'R4-local', 'none'],
    ['CI tests', { SAGA_LOCAL: '1', NODE_ENV: 'test' }, LOCAL, 'R4-local', 'none'],
  ] as const)('%s', (_name, vars, account, row, lane) => {
    expect(parseIdentity(vars, account)).toMatchObject({ row, lane, account });
  });

  it('derives profile from EXEC_ENV; unset or prod is the prod profile', () => {
    expect(parseIdentity({}, LOCAL).profile).toBe('prod');
    expect(parseIdentity({ EXEC_ENV: 'prod' }, DEV).profile).toBe('prod');
    expect(parseIdentity({ EXEC_ENV: 'dev' }, DEV).profile).toBe('dev');
  });

  it('selects the row by account x lane, not by profile', () => {
    expect(parseIdentity({ EXEC_ENV: 'prod' }, DEV).row).toBe('R3-dev-overlay');
    expect(parseIdentity({ EXEC_ENV: 'prod', LANE: 'twin' }, DEV).row).toBe('R2-lane');
  });

  it('telemetryEnv comes from DD_ENV, else the account kind, never the profile', () => {
    expect(parseIdentity({ EXEC_ENV: 'prod', DD_ENV: ' staging ' }, DEV).telemetryEnv).toBe(
      'staging'
    );
    expect(parseIdentity({ EXEC_ENV: 'prod' }, DEV).telemetryEnv).toBe('dev');
    expect(parseIdentity({}, PROD).telemetryEnv).toBe('prod');
  });

  describe('boot-fail rows', () => {
    it.each([
      ['prod account + twin', { LANE: 'twin' }, PROD, /prod account/],
      ['prod account + mirror', { LANE: 'mirror' }, PROD, /prod account/],
      ['invalid lane', { LANE: 'sideways' }, DEV, /LANE must be/],
      ['prod account + EXEC_ENV=dev', { EXEC_ENV: 'dev' }, PROD, /EXEC_ENV=dev/],
      ['SAGA_LOCAL + LANE=twin', { LANE: 'twin' }, LOCAL, /conflicts with LANE/],
      ['SAGA_LOCAL + LANE=mirror', { LANE: 'mirror' }, LOCAL, /conflicts with LANE/],
      ['EXEC_ENV=dev on a lane', { EXEC_ENV: 'dev', LANE: 'twin' }, DEV, /EXEC_ENV=dev/],
      ['EXEC_ENV=dev on local', { EXEC_ENV: 'dev' }, LOCAL, /EXEC_ENV=dev/],
      ['unknown EXEC_ENV', { EXEC_ENV: 'staging' }, DEV, /EXEC_ENV must be/],
    ])('%s throws EnvIdentityError', (_name, vars, account, message) => {
      expect(() => parseIdentity(vars, account)).toThrow(EnvIdentityError);
      expect(() => parseIdentity(vars, account)).toThrow(message);
    });
  });

  it.each([PROD, DEV, LOCAL])(
    'EXEC_ENV=mirror throws a message containing "set LANE=mirror" (%j)',
    account => {
      expect(() => parseIdentity({ EXEC_ENV: 'mirror' }, account)).toThrow(/set LANE=mirror/);
      expect(() => parseIdentity({ EXEC_ENV: ' Mirror ' }, account)).toThrow(EnvIdentityError);
    }
  );
});
