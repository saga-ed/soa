import { describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const destroy = vi.fn();
const ctor = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    constructor(cfg: unknown) {
      ctor(cfg);
    }
    send = send;
    destroy = destroy;
  },
  GetCallerIdentityCommand: class {},
}));

import { createStsAccountResolver } from '../aws.js';

describe('createStsAccountResolver', () => {
  it('returns the caller account from STS and releases the client', async () => {
    send.mockResolvedValueOnce({ Account: '396913734878' });
    await expect(createStsAccountResolver({ region: 'us-west-2' })()).resolves.toBe('396913734878');
    expect(ctor).toHaveBeenCalledWith({ region: 'us-west-2' });
    expect(destroy).toHaveBeenCalled();
  });

  it('propagates STS failure (the core treats it as unresolved)', async () => {
    send.mockRejectedValueOnce(new Error('no credentials'));
    await expect(createStsAccountResolver()()).rejects.toThrow('no credentials');
  });
});
