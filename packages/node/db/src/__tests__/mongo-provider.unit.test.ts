import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the mongodb driver so we can drive connect()/ping() without a real DB.
// `new MongoClient(...)` returns a single shared `instance`; its connect/db/
// close are individually controllable mocks.
// ---------------------------------------------------------------------------
const { MongoClientMock, connectMock, commandMock, closeMock, instance } =
  vi.hoisted(() => {
    const commandMock = vi.fn();
    const closeMock = vi.fn();
    const connectMock = vi.fn();
    const instance = {
      connect: connectMock,
      close: closeMock,
      db: vi.fn(() => ({ command: commandMock })),
    };
    const MongoClientMock = vi.fn(() => instance);
    return { MongoClientMock, connectMock, commandMock, closeMock, instance };
  });

vi.mock('mongodb', () => ({ MongoClient: MongoClientMock }));

// vi.mock/vi.hoisted are hoisted above these imports.
import { MongoProvider } from '../mongo-provider.js';
import type { MongoProviderConfig } from '../mongo-provider-config.js';

const baseConfig: MongoProviderConfig = {
  configType: 'MONGO',
  instanceName: 'unit',
  hosts: ['localhost:27017'],
  database: 'app_db',
};

const authError = (code: number) => Object.assign(new Error('auth failed'), { code });

beforeEach(() => {
  vi.clearAllMocks();
  MongoClientMock.mockReset();
  connectMock.mockReset();
  commandMock.mockReset();
  closeMock.mockReset();
  MongoClientMock.mockReturnValue(instance);
  connectMock.mockResolvedValue(instance);
  commandMock.mockResolvedValue({ ok: 1 });
  closeMock.mockResolvedValue(undefined);
});

describe('MongoProvider lifecycle', () => {
  it('tracks isConnected across connect/disconnect via a flag (not a private driver field)', async () => {
    const provider = new MongoProvider(baseConfig);
    expect(provider.isConnected()).toBe(false);

    await provider.connect();
    expect(provider.isConnected()).toBe(true);

    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  it('connect() is idempotent', async () => {
    const provider = new MongoProvider(baseConfig);
    await provider.connect();
    await provider.connect();
    expect(MongoClientMock).toHaveBeenCalledTimes(1);
  });
});

describe('MongoProvider.ping', () => {
  it('returns false before connect', async () => {
    expect(await new MongoProvider(baseConfig).ping()).toBe(false);
  });

  it('returns true when admin.ping succeeds', async () => {
    const provider = new MongoProvider(baseConfig);
    await provider.connect();
    expect(await provider.ping()).toBe(true);
    expect(commandMock).toHaveBeenCalledWith({ ping: 1 });
  });

  it('returns false (does not throw) when the server is unreachable', async () => {
    const provider = new MongoProvider(baseConfig);
    await provider.connect();
    commandMock.mockRejectedValueOnce(new Error('no primary available'));
    expect(await provider.ping()).toBe(false);
  });
});

describe('MongoProvider.connect retry', () => {
  it('retries a transient failure and succeeds on a later attempt', async () => {
    vi.useFakeTimers();
    connectMock
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(instance);

    const provider = new MongoProvider(baseConfig);
    const connecting = provider.connect();
    await vi.runAllTimersAsync();
    await connecting;

    expect(provider.isConnected()).toBe(true);
    expect(MongoClientMock).toHaveBeenCalledTimes(2); // a fresh client per attempt
    vi.useRealTimers();
  });

  it('gives up after maxRetries and rethrows', async () => {
    vi.useFakeTimers();
    connectMock.mockRejectedValue(new Error('cluster down'));

    const provider = new MongoProvider(baseConfig);
    const captured = provider.connect().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await captured;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('cluster down');
    expect(provider.isConnected()).toBe(false);
    expect(MongoClientMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does NOT retry a non-retryable auth error (AuthenticationFailed=18)', async () => {
    connectMock.mockRejectedValue(authError(18));

    const provider = new MongoProvider(baseConfig);
    await expect(provider.connect()).rejects.toThrow('auth failed');
    expect(MongoClientMock).toHaveBeenCalledTimes(1); // failed fast, no retry
  });

  it('does NOT retry Unauthorized=13 either', async () => {
    connectMock.mockRejectedValue(authError(13));

    const provider = new MongoProvider(baseConfig);
    await expect(provider.connect()).rejects.toThrow('auth failed');
    expect(MongoClientMock).toHaveBeenCalledTimes(1);
  });
});
