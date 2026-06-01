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

  it('does not register a connect handler when no session timeouts are set', async () => {
    await new PostgresProvider(baseConfig()).connect();
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
