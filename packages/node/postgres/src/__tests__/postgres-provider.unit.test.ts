import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `pg` so we can drive Pool lifecycle/event callbacks without a real DB.
// A single shared poolInstance is returned for every `new Pool(...)`; the
// constructor options and registered event handlers are captured in `state`.
// ---------------------------------------------------------------------------
const { PoolMock, poolInstance, state } = vi.hoisted(() => {
  const state: {
    options?: Record<string, unknown>;
    handlers: Record<string, (...args: unknown[]) => void>;
  } = { handlers: {} };

  const poolInstance = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      state.handlers[event] = cb;
      return poolInstance;
    }),
    connect: vi.fn(),
    end: vi.fn(),
  };

  const PoolMock = vi.fn((options: Record<string, unknown>) => {
    state.options = options;
    return poolInstance;
  });

  return { PoolMock, poolInstance, state };
});

vi.mock('pg', () => ({ Pool: PoolMock }));

// vi.mock + vi.hoisted are hoisted above these imports, so PostgresProvider
// picks up the mocked `pg`.
import { PostgresProvider } from '../postgres-provider.js';
import {
  PostgresProviderSchema,
  type PostgresProviderConfig,
} from '../postgres-provider-config.js';

const baseConfig = (
  overrides: Record<string, unknown> = {},
): PostgresProviderConfig =>
  PostgresProviderSchema.parse({
    instanceName: 'TestDB',
    host: 'localhost',
    database: 'testdb',
    username: 'tester',
    password: 'secret',
    ...overrides,
  });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  state.handlers = {};
  state.options = undefined;
  poolInstance.connect.mockResolvedValue({ release: vi.fn() });
  poolInstance.end.mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('PostgresProvider resilience', () => {
  it('registers an idle-client error handler so an RDS drop cannot crash the process', async () => {
    const provider = new PostgresProvider(baseConfig());
    await provider.connect();

    expect(provider.isConnected()).toBe(true);
    expect(state.handlers.error).toBeTypeOf('function');

    // Simulate an idle client error (e.g. RDS failover). Emitting an
    // 'error' event with no listener would throw; ours must not.
    expect(() =>
      state.handlers.error(new Error('Connection terminated unexpectedly')),
    ).not.toThrow();

    // Provider reports unhealthy, but the pool is retained so it can
    // self-heal on the next acquire.
    expect(provider.isConnected()).toBe(false);
    expect(() => provider.getPool()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('enables TCP keepAlive on the pool', async () => {
    await new PostgresProvider(baseConfig()).connect();
    expect(state.options?.keepAlive).toBe(true);
  });

  it('does not let a failing session-timeout SET become an unhandled rejection', async () => {
    const provider = new PostgresProvider(
      baseConfig({ statementTimeoutMs: 5000, lockTimeoutMs: 2000 }),
    );
    await provider.connect();

    expect(state.handlers.connect).toBeTypeOf('function');

    const failingClient = {
      query: vi.fn().mockRejectedValue(new Error('backend gone')),
    };
    // Invoking the per-connection setup must not throw, and the rejected
    // SET must be swallowed (the .catch handles it).
    expect(() => state.handlers.connect(failingClient)).not.toThrow();
    expect(failingClient.query).toHaveBeenCalledWith('SET statement_timeout = 5000');
    expect(failingClient.query).toHaveBeenCalledWith('SET lock_timeout = 2000');

    // Let the swallowed rejections settle; an unhandled one would surface
    // as a test failure.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('registers a connect handler that sets the idle-in-transaction guard by default (gh-186)', async () => {
    // The idle guard defaults ON, so a connect handler is registered even with
    // no statement/lock timeouts — and it issues only the idle SET.
    const provider = new PostgresProvider(baseConfig());
    await provider.connect();

    expect(state.handlers.connect).toBeTypeOf('function');
    const client = { query: vi.fn().mockResolvedValue(undefined) };
    state.handlers.connect(client);
    expect(client.query).toHaveBeenCalledWith(
      'SET idle_in_transaction_session_timeout = 30000',
    );
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('statement_timeout'));
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('lock_timeout'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('registers no connect handler when every session timeout (incl. the idle guard) is disabled', async () => {
    await new PostgresProvider(
      baseConfig({ idleInTransactionSessionTimeoutMs: 0 }),
    ).connect();
    expect(state.handlers.connect).toBeUndefined();
  });

  it('connect() is idempotent — a second call does not create a second pool', async () => {
    const provider = new PostgresProvider(baseConfig());
    await provider.connect();
    await provider.connect();
    expect(PoolMock).toHaveBeenCalledTimes(1);
  });

  it('an idle error does not let a follow-up connect() leak a second pool', async () => {
    const provider = new PostgresProvider(baseConfig());
    await provider.connect();

    state.handlers.error(new Error('drop'));
    expect(provider.isConnected()).toBe(false);

    // Even though the health flag is false, the live pool guards against
    // building (and leaking) a replacement.
    await provider.connect();
    expect(PoolMock).toHaveBeenCalledTimes(1);
  });

  it('retries connect with backoff and ends the failed attempt’s pool', async () => {
    vi.useFakeTimers();
    poolInstance.connect
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ release: vi.fn() });

    const provider = new PostgresProvider(baseConfig());
    const connecting = provider.connect();
    await vi.runAllTimersAsync();
    await connecting;

    expect(provider.isConnected()).toBe(true);
    expect(PoolMock).toHaveBeenCalledTimes(2); // a fresh pool per attempt
    expect(poolInstance.end).toHaveBeenCalledTimes(1); // failed pool torn down
    vi.useRealTimers();
  });
});

describe('PostgresProvider config sources', () => {
  it('accepts a PostgresPoolConfig with an async password callback (IAM/RDS path)', async () => {
    const tokenFn = vi.fn(async () => 'iam-token');
    const provider = new PostgresProvider({
      instanceName: 'IamDB',
      host: 'rds.example',
      port: 5432,
      database: 'chat',
      user: 'chat_app',
      password: tokenFn,
      ssl: true,
    });
    await provider.connect();

    expect(provider.instanceName).toBe('IamDB');
    // Discrete options (no connectionString) so pg honors the callback —
    // it is passed through untouched and invoked per new connection by pg.
    expect(state.options?.password).toBe(tokenFn);
    expect(state.options?.user).toBe('chat_app');
    expect(state.options?.host).toBe('rds.example');
    expect(state.options?.ssl).toBe(true);
    expect(state.options?.keepAlive).toBe(true);
    expect(state.options).not.toHaveProperty('connectionString');
  });

  it('applies pool-tuning defaults when a PostgresPoolConfig omits them', async () => {
    await new PostgresProvider({
      instanceName: 'D',
      host: 'h',
      port: 5432,
      database: 'd',
      user: 'u',
      password: 'p',
      ssl: false,
    }).connect();

    expect(state.options?.max).toBe(10);
    expect(state.options?.idleTimeoutMillis).toBe(30_000);
    expect(state.options?.connectionTimeoutMillis).toBe(10_000);
  });

  it('maps the static schema config (username + string password) onto pool options', async () => {
    await new PostgresProvider(baseConfig({ ssl: true, poolSize: 7 })).connect();

    expect(state.options?.user).toBe('tester'); // schema `username` -> pg `user`
    expect(state.options?.password).toBe('secret');
    expect(state.options?.ssl).toBe(true);
    expect(state.options?.max).toBe(7);
  });

  it('passes a CA-bundle ssl object straight through to pg (PostgresPoolConfig path)', async () => {
    const ssl = { ca: '-----BEGIN CERTIFICATE-----\nMIIB...', rejectUnauthorized: true };
    await new PostgresProvider({
      instanceName: 'RdsDB',
      host: 'rds.example',
      port: 5432,
      database: 'iam_db',
      user: 'iam_api_app',
      password: async () => 'iam-token',
      ssl,
    }).connect();

    // pg forwards the object verbatim to tls.connect — the CA pin survives.
    expect(state.options?.ssl).toEqual(ssl);
  });

  it('accepts and passes through an ssl object on the static schema path', async () => {
    const ssl = { ca: 'PEM', rejectUnauthorized: true };
    await new PostgresProvider(baseConfig({ ssl })).connect();
    expect(state.options?.ssl).toEqual(ssl);
  });
});
