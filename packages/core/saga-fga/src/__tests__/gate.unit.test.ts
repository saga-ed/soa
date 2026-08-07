import { describe, it, expect, vi } from 'vitest';
import {
  loadFgaGateConfig,
  enforceFgaRelation,
  createFgaGate,
  fgaBatchKey,
  FgaUnavailableError,
  type FgaGate,
} from '../index.js';

const checkMock = vi.hoisted(() => vi.fn());
const batchCheckMock = vi.hoisted(() => vi.fn());
const listUsersMock = vi.hoisted(() => vi.fn());
// Capture constructor args so we can assert on the CLIENT CONFIG, not just on
// calls — a token that never reaches the constructor never reaches the wire.
const clientConfigs = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@openfga/sdk', () => ({
  CredentialsMethod: {
    None: 'none',
    ApiToken: 'api_token',
    ClientCredentials: 'client_credentials',
  },
  OpenFgaClient: class {
    check = checkMock;
    batchCheck = batchCheckMock;
    listUsers = listUsersMock;
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
  },
}));

/** Echo back an `allowed` verdict per requested item, in request order. */
const respondAllowing = (allow: (item: { object: string; relation: string }) => boolean) =>
  batchCheckMock
    .mockReset()
    .mockImplementation(
      (body: {
        checks: { user: string; relation: string; object: string; correlationId: string }[];
      }) =>
        Promise.resolve({
          result: body.checks.map(c => ({
            allowed: allow(c),
            request: c,
            correlationId: c.correlationId,
          })),
        })
    );

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
      async check() {
        called = true;
        return false;
      },
    };
    await enforceFgaRelation(
      gate,
      'user:a',
      'host',
      'session:s',
      () => new Error('should not throw')
    );
    expect(called).toBe(false);
  });

  it('throws makeForbidden() when the relation does not hold', async () => {
    const gate: Pick<FgaGate, 'enforce' | 'check'> = {
      enforce: true,
      async check() {
        return false;
      },
    };
    await expect(
      enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('forbidden'))
    ).rejects.toThrow('forbidden');
  });

  it('passes (resolves) when the relation holds', async () => {
    let asked: [string, string, string] | undefined;
    const gate: Pick<FgaGate, 'enforce' | 'check'> = {
      enforce: true,
      async check(u, r, o) {
        asked = [u, r, o];
        return true;
      },
    };
    await expect(
      enforceFgaRelation(gate, 'user:a', 'host', 'session:s', () => new Error('forbidden'))
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
    checkMock
      .mockReset()
      .mockImplementation((req: { relation: string }) =>
        Promise.resolve({ allowed: req.relation === relation })
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

describe('batchCheck — the authorization-filtered-list primitive', () => {
  const districts = ['staff_org:d1', 'staff_org:d2', 'staff_org:d3'];
  const asChecks = (objects: string[]) =>
    objects.map(object => ({ user: 'user:a', relation: 'can_view', object }));

  it('returns one verdict per item, keyed by fgaBatchKey', async () => {
    respondAllowing(c => c.object !== 'staff_org:d2');
    const verdicts = await gateWithStore().batchCheck(asChecks(districts));

    expect(verdicts.size).toBe(3);
    expect(verdicts.get(fgaBatchKey('user:a', 'can_view', 'staff_org:d1'))).toBe(true);
    expect(verdicts.get(fgaBatchKey('user:a', 'can_view', 'staff_org:d2'))).toBe(false);
    expect(verdicts.get(fgaBatchKey('user:a', 'can_view', 'staff_org:d3'))).toBe(true);
  });

  it('short-circuits an empty request without touching the client', async () => {
    batchCheckMock.mockReset();
    await expect(gateWithStore().batchCheck([])).resolves.toEqual(new Map());
    expect(batchCheckMock).not.toHaveBeenCalled();
  });

  it('sends wire correlation ids OpenFGA will accept (≤36 chars, [A-Za-z0-9-])', async () => {
    // The natural key `user:<uuid>|can_view|staff_org:<uuid>` violates BOTH the
    // charset and the length cap, so it can never be the wire id.
    respondAllowing(() => true);
    const uuid = '11111111-2222-3333-4444-555555555555';
    await gateWithStore().batchCheck([
      { user: `user:${uuid}`, relation: 'can_view', object: `staff_org:${uuid}` },
    ]);

    const sent = batchCheckMock.mock.calls[0]?.[0] as {
      checks: { correlationId: string }[];
    };
    for (const c of sent.checks) {
      expect(c.correlationId).toMatch(/^[A-Za-z0-9-]{1,36}$/);
    }
  });

  it('correlates by correlationId, not response order', async () => {
    // A server that answers out of order must not shuffle the verdicts.
    batchCheckMock
      .mockReset()
      .mockImplementation(
        (body: { checks: { relation: string; object: string; correlationId: string }[] }) =>
          Promise.resolve({
            result: [...body.checks].reverse().map(c => ({
              allowed: c.object === 'staff_org:d1',
              request: c,
              correlationId: c.correlationId,
            })),
          })
      );
    const verdicts = await gateWithStore().batchCheck(asChecks(districts));

    expect(verdicts.get(fgaBatchKey('user:a', 'can_view', 'staff_org:d1'))).toBe(true);
    expect(verdicts.get(fgaBatchKey('user:a', 'can_view', 'staff_org:d3'))).toBe(false);
  });

  it('passes >50 items through in one call and lets the SDK chunk them', async () => {
    respondAllowing(() => true);
    const many = asChecks(Array.from({ length: 120 }, (_, i) => `staff_org:d${i}`));
    const verdicts = await gateWithStore().batchCheck(many);

    expect(verdicts.size).toBe(120);
    // Chunking is the SDK's job (maxBatchSize 50) — we must not pre-split, or we
    // lose its parallelism control.
    expect(batchCheckMock).toHaveBeenCalledTimes(1);
    expect((batchCheckMock.mock.calls[0]?.[0] as { checks: unknown[] }).checks).toHaveLength(120);
  });

  it('collapses duplicate questions to a single entry', async () => {
    respondAllowing(() => true);
    const verdicts = await gateWithStore().batchCheck(asChecks(['staff_org:d1', 'staff_org:d1']));
    expect(verdicts.size).toBe(1);
  });
});

describe('batchCheck — a per-item failure is NOT a deny', () => {
  const one = [{ user: 'user:a', relation: 'can_view', object: 'staff_org:d1' }];

  it('throws when any item carries an error, rather than reporting it false', async () => {
    // The whole reason this method belongs in this package: a silent `false` here
    // would hide an outage as a permission denial on a list surface.
    batchCheckMock.mockReset().mockResolvedValue({
      result: [
        {
          allowed: false,
          request: { user: 'user:a', relation: 'can_view', object: 'staff_org:d1' },
          correlationId: 'c0',
          error: { input_error: 'validation_error', message: 'boom' },
        },
      ],
    });
    await expect(gateWithStore().batchCheck(one)).rejects.toThrow(FgaUnavailableError);
  });

  it('throws when the response omits a requested item', async () => {
    batchCheckMock.mockReset().mockResolvedValue({ result: [] });
    await expect(gateWithStore().batchCheck(one)).rejects.toThrow(FgaUnavailableError);
  });

  it('throws on an unrecognized correlationId rather than guessing', async () => {
    batchCheckMock.mockReset().mockResolvedValue({
      result: [
        {
          allowed: true,
          request: { user: 'user:a', relation: 'can_view', object: 'staff_org:d1' },
          correlationId: 'not-ours',
        },
      ],
    });
    await expect(gateWithStore().batchCheck(one)).rejects.toThrow(FgaUnavailableError);
  });

  it('surfaces a transport failure as FgaUnavailableError', async () => {
    batchCheckMock.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(gateWithStore().batchCheck(one)).rejects.toThrow(FgaUnavailableError);
  });

  it('surfaces a missing store id without reaching the client', async () => {
    batchCheckMock.mockReset();
    const gate = createFgaGate({ enforce: true, apiUrl: 'http://fga.test' });
    await expect(gate.batchCheck(one)).rejects.toThrow(FgaUnavailableError);
    expect(batchCheckMock).not.toHaveBeenCalled();
  });
});

describe('listUsersDiagnostic — the reverse (debug-tier) question', () => {
  // The wire accepts exactly ONE user_filter per ListUsers call, so the mock
  // answers per filter — a multi-filter request would be a real-server 400.
  const respondPerFilter = () =>
    listUsersMock
      .mockReset()
      .mockImplementation((req: { user_filters: { type: string; relation?: string }[] }) => {
        expect(req.user_filters).toHaveLength(1);
        return Promise.resolve({
          users: req.user_filters[0]?.relation
            ? [{ userset: { type: 'group', id: 'demo-north', relation: 'member' } }]
            : [{ object: { type: 'user', id: 'ingrid' } }, { wildcard: { type: 'user' } }],
        });
      });

  it('fans out one wire call per subject shape and merges the partitions', async () => {
    respondPerFilter();
    const listing = await gateWithStore().listUsersDiagnostic('can_view', 'qtf_review:r1', [
      'user',
      'group#member',
    ]);

    expect(listing).toEqual({
      users: ['user:ingrid'],
      usersets: ['group:demo-north#member'],
      wildcardTypes: ['user'],
    });
    expect(listUsersMock).toHaveBeenCalledTimes(2);
    expect(listUsersMock.mock.calls[0]?.[0]).toEqual({
      object: { type: 'qtf_review', id: 'r1' },
      relation: 'can_view',
      user_filters: [{ type: 'user' }],
    });
    expect(listUsersMock.mock.calls[1]?.[0]).toMatchObject({
      user_filters: [{ type: 'group', relation: 'member' }],
    });
  });

  it('collapses duplicate filters to one wire call — no double-counted subjects', async () => {
    respondPerFilter();
    const listing = await gateWithStore().listUsersDiagnostic('can_view', 'qtf_review:r1', [
      'user',
      'user',
    ]);
    expect(listUsersMock).toHaveBeenCalledTimes(1);
    expect(listing.users).toEqual(['user:ingrid']);
  });

  it('splits the object on the FIRST colon only — instance ids contain separators', async () => {
    listUsersMock.mockReset().mockResolvedValue({ users: [] });
    await gateWithStore().listUsersDiagnostic('host', 'session_instance:S|2026-08-05', ['user']);
    expect(listUsersMock.mock.calls[0]?.[0]).toMatchObject({
      object: { type: 'session_instance', id: 'S|2026-08-05' },
    });
  });

  it('rejects an un-typed or id-less object as a caller bug (TypeError), never as unavailability', async () => {
    listUsersMock.mockReset();
    const gate = gateWithStore();
    // 'session:' is the empty-interpolation bug (`session:${id}` with id '').
    for (const bad of ['no-type-separator', 'session:', ':s1']) {
      await expect(gate.listUsersDiagnostic('host', bad, ['user'])).rejects.toThrow(TypeError);
    }
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed relation as a caller bug (TypeError)', async () => {
    listUsersMock.mockReset();
    const gate = gateWithStore();
    for (const bad of ['', 'can view', 'session:can_view', 'can_view#x']) {
      await expect(gate.listUsersDiagnostic(bad, 'session:s1', ['user'])).rejects.toThrow(
        TypeError
      );
    }
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it('rejects malformed subject-type filters as caller bugs (TypeError)', async () => {
    listUsersMock.mockReset();
    const gate = gateWithStore();
    for (const bad of ['#member', 'group#', 'group:member', '', 'group#member#extra']) {
      await expect(gate.listUsersDiagnostic('can_view', 'session:s1', [bad])).rejects.toThrow(
        TypeError
      );
    }
    // An empty filter list means "no shapes", not "all shapes" — reject it too.
    await expect(gate.listUsersDiagnostic('can_view', 'session:s1', [])).rejects.toThrow(TypeError);
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it('surfaces a transport failure as FgaUnavailableError — an outage must never read as an empty listing', async () => {
    listUsersMock.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      gateWithStore().listUsersDiagnostic('host', 'session:s1', ['user'])
    ).rejects.toThrow(FgaUnavailableError);
  });

  it('surfaces a 2xx body with no users array as FgaUnavailableError, not an empty listing', async () => {
    listUsersMock.mockReset().mockResolvedValue({});
    await expect(
      gateWithStore().listUsersDiagnostic('host', 'session:s1', ['user'])
    ).rejects.toThrow(FgaUnavailableError);
  });

  it('throws on an unrecognized or partial subject entry rather than misreporting it', async () => {
    const gate = gateWithStore();
    // A partial entry would otherwise stringify as a phantom subject like
    // 'user:undefined' that matches no real tuple.
    for (const entry of [
      {},
      { object: {} },
      { object: { type: 'user' } },
      { userset: { type: 'group', id: 'g' } },
    ]) {
      listUsersMock.mockReset().mockResolvedValue({ users: [entry] });
      await expect(gate.listUsersDiagnostic('host', 'session:s1', ['user'])).rejects.toThrow(
        FgaUnavailableError
      );
    }
  });

  it('surfaces a missing store id without reaching the client', async () => {
    listUsersMock.mockReset();
    const gate = createFgaGate({ enforce: true, apiUrl: 'http://fga.test' });
    await expect(gate.listUsersDiagnostic('host', 'session:s1', ['user'])).rejects.toThrow(
      FgaUnavailableError
    );
    expect(listUsersMock).not.toHaveBeenCalled();
  });
});

describe('an unreachable verdict is NOT a deny', () => {
  it('surfaces a transport failure as FgaUnavailableError', async () => {
    checkMock.mockReset().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(gateWithStore().check('user:a', 'host', 'session:s')).rejects.toThrow(
      FgaUnavailableError
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
      gateWithStore().checkDetailed('user:a', ['host', 'edit_grant'], 'session:s')
    ).rejects.toThrow(FgaUnavailableError);
  });

  it('propagates through enforceFgaRelation instead of throwing makeForbidden()', async () => {
    checkMock.mockReset().mockRejectedValue(new Error('boom'));
    await expect(
      enforceFgaRelation(
        gateWithStore(),
        'user:a',
        'host',
        'session:s',
        () => new Error('MASKED-AS-DENY')
      )
    ).rejects.toThrow(FgaUnavailableError);
  });
});
