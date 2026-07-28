import { describe, it, expect, vi } from 'vitest';
import {
  loadFgaGateConfig,
  enforceFgaRelation,
  createFgaGate,
  FgaUnavailableError,
  type FgaGate,
} from '../index.js';

const checkMock = vi.hoisted(() => vi.fn());
// Capture constructor args so we can assert on the CLIENT CONFIG, not just on
// calls — a token that never reaches the constructor never reaches the wire.
const clientConfigs = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@openfga/sdk', () => ({
  CredentialsMethod: { None: 'none', ApiToken: 'api_token', ClientCredentials: 'client_credentials' },
  OpenFgaClient: class {
    check = checkMock;
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
  },
}));

const gateWithStore = () =>
  createFgaGate({ enforce: true, apiUrl: 'http://fga.test', storeId: 's1' });

describe('saga-fga gate config', () => {
  it('defaults enforcement OFF', () => {
    expect(loadFgaGateConfig({}).enforce).toBe(false);
  });

  it('enables enforcement only on the exact string "true"', () => {
    expect(loadFgaGateConfig({ AUTHZ_FGA_ENFORCE: 'true' }).enforce).toBe(true);
    expect(loadFgaGateConfig({ AUTHZ_FGA_ENFORCE: '1' }).enforce).toBe(false);
    expect(loadFgaGateConfig({ AUTHZ_FGA_ENFORCE: 'TRUE' }).enforce).toBe(false);
  });

  it('reads endpoint + store/model from env, with a localhost default', () => {
    const c = loadFgaGateConfig({ OPENFGA_STORE_ID: 's1', OPENFGA_MODEL_ID: 'm1' });
    expect(c.apiUrl).toBe('http://localhost:8080');
    expect(c.storeId).toBe('s1');
    expect(c.modelId).toBe('m1');
  });

  it('reads the preshared key from OPENFGA_API_TOKEN, undefined when absent or empty', () => {
    expect(loadFgaGateConfig({ OPENFGA_API_TOKEN: 'k1' }).apiToken).toBe('k1');
    expect(loadFgaGateConfig({}).apiToken).toBeUndefined();
    // An empty env var is "unset", not a token — an empty Bearer would 401.
    expect(loadFgaGateConfig({ OPENFGA_API_TOKEN: '' }).apiToken).toBeUndefined();
  });
});

describe('preshared-key credentials', () => {
  // The shared dev/prod OpenFGA run authn=preshared. A gate that never puts the
  // token on the client 401s every call — which surfaces as unavailability, not
  // a deny, so it fails in the right DIRECTION but answers nothing.
  it('configures ApiToken credentials on the client when a token is set', async () => {
    clientConfigs.length = 0;
    checkMock.mockResolvedValue({ allowed: true });
    const gate = createFgaGate({
      enforce: true,
      apiUrl: 'http://fga.test',
      storeId: 's1',
      apiToken: 'preshared-abc',
    });
    await gate.check('user:u1', 'viewer', 'session:s1');

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]?.credentials).toEqual({
      method: 'api_token',
      config: { token: 'preshared-abc' },
    });
  });

  it('omits credentials entirely when no token is configured', async () => {
    clientConfigs.length = 0;
    checkMock.mockResolvedValue({ allowed: true });
    await gateWithStore().check('user:u1', 'viewer', 'session:s1');

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]).not.toHaveProperty('credentials');
  });
});

describe('enforceFgaRelation', () => {
  it('is a no-op when the gate is disabled — never calls check', async () => {
    let called = false;
    const gate: Pick<FgaGate, 'enforce' | 'check'> = {
      enforce: false,
      async check() { called = true; return false; },
    };
    await enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('should not throw'));
    expect(called).toBe(false);
  });

  it('throws makeForbidden() when the relation does not hold', async () => {
    const gate: Pick<FgaGate, 'enforce' | 'check'> = { enforce: true, async check() { return false; } };
    await expect(
      enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('forbidden')),
    ).rejects.toThrow('forbidden');
  });

  it('passes (resolves) when the relation holds', async () => {
    let asked: [string, string, string] | undefined;
    const gate: Pick<FgaGate, 'enforce' | 'check'> = {
      enforce: true,
      async check(u, r, o) { asked = [u, r, o]; return true; },
    };
    await expect(
      enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('forbidden')),
    ).resolves.toBeUndefined();
    expect(asked).toEqual(['user:a', 'host', 'session:s']);
  });
});

describe('contextual tuples', () => {
  it('forwards them to the client, and omits the key entirely when absent', async () => {
    checkMock.mockReset().mockResolvedValue({ allowed: true });
    const gate = gateWithStore();
    const tuples = [{ user: 'pod:p1', relation: 'pod', object: 'session:s' }];

    await gate.check('user:a', 'can_edit', 'session:s', tuples);
    expect(checkMock.mock.calls[0]?.[0]).toMatchObject({ contextualTuples: tuples });

    await gate.check('user:a', 'can_edit', 'session:s');
    expect(checkMock.mock.calls[1]?.[0]).not.toHaveProperty('contextualTuples');

    // An empty array is "no contextual facts", not an empty payload to send.
    await gate.check('user:a', 'can_edit', 'session:s', []);
    expect(checkMock.mock.calls[2]?.[0]).not.toHaveProperty('contextualTuples');
  });
});

describe('checkDetailed attribution', () => {
  const allowOnly = (relation: string) =>
    checkMock.mockReset().mockImplementation(
      (req: { relation: string }) => Promise.resolve({ allowed: req.relation === relation }),
    );

  it('reports which branch fired', async () => {
    allowOnly('edit_grant');
    const d = await gateWithStore().checkDetailed('user:a', ['host', 'edit_grant'], 'session:s');
    expect(d).toEqual({ allowed: true, via: 'edit_grant', branches: ['edit_grant'] });
  });

  it('prefers the earliest branch supplied when several hold (HOST beats ADMIN)', async () => {
    checkMock.mockReset().mockResolvedValue({ allowed: true });
    const d = await gateWithStore().checkDetailed('user:a', ['host', 'edit_grant'], 'session:s');
    expect(d.via).toBe('host');
    expect(d.branches).toEqual(['host', 'edit_grant']);
  });

  it('denies with no attribution when no branch holds', async () => {
    allowOnly('none');
    const d = await gateWithStore().checkDetailed('user:a', ['host', 'edit_grant'], 'session:s');
    expect(d).toEqual({ allowed: false, via: undefined, branches: [] });
  });

  it('passes contextual tuples to every branch', async () => {
    checkMock.mockReset().mockResolvedValue({ allowed: false });
    const tuples = [{ user: 'user:a', relation: 'host', object: 'session:s' }];
    await gateWithStore().checkDetailed('user:a', ['host', 'edit_grant'], 'session:s', tuples);
    expect(checkMock).toHaveBeenCalledTimes(2);
    for (const call of checkMock.mock.calls) {
      expect(call[0]).toMatchObject({ contextualTuples: tuples });
    }
  });
});

describe('an unreachable verdict is NOT a deny', () => {
  it('surfaces a transport failure as FgaUnavailableError', async () => {
    checkMock.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(gateWithStore().check('user:a', 'host', 'session:s')).rejects.toThrow(
      FgaUnavailableError,
    );
  });

  it('surfaces a missing store id as FgaUnavailableError, not false', async () => {
    checkMock.mockReset();
    const gate = createFgaGate({ enforce: true, apiUrl: 'http://fga.test' });
    await expect(gate.check('user:a', 'host', 'session:s')).rejects.toThrow(FgaUnavailableError);
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('propagates out of checkDetailed rather than degrading to a denial', async () => {
    checkMock.mockReset().mockRejectedValue(new Error('boom'));
    await expect(
      gateWithStore().checkDetailed('user:a', ['host', 'edit_grant'], 'session:s'),
    ).rejects.toThrow(FgaUnavailableError);
  });

  it('propagates through enforceFgaRelation instead of throwing makeForbidden()', async () => {
    checkMock.mockReset().mockRejectedValue(new Error('boom'));
    await expect(
      enforceFgaRelation(gateWithStore(), 'user:a', 'host', 'session:s', () =>
        new Error('MASKED-AS-DENY'),
      ),
    ).rejects.toThrow(FgaUnavailableError);
  });
});
