import { describe, it, expect, vi } from 'vitest';
import { createGracefulShutdown } from '../graceful-shutdown.js';
import type { BootstrapLogger } from '../types.js';

function fakeLogger(): BootstrapLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeServer() {
  return { close: (cb?: (err?: Error) => void) => cb && cb() };
}

describe('createGracefulShutdown', () => {
  it('closes the http server first, then closers in order', async () => {
    const order: string[] = [];
    const server = {
      close: (cb?: (err?: Error) => void) => {
        order.push('server');
        cb && cb();
      },
    };
    const shutdown = createGracefulShutdown({
      logger: fakeLogger(),
      server,
      closers: [
        { name: 'relay', close: () => void order.push('relay') },
        { name: 'db', close: () => void order.push('db') },
      ],
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['server', 'relay', 'db']);
  });

  it('is best-effort: a throwing closer is logged and the rest still run', async () => {
    const logger = fakeLogger();
    const ran: string[] = [];
    const shutdown = createGracefulShutdown({
      logger,
      server: fakeServer(),
      closers: [
        {
          name: 'flaky',
          close: () => {
            throw new Error('boom');
          },
        },
        { name: 'after', close: () => void ran.push('after') },
      ],
    });

    await shutdown('SIGINT');

    expect(ran).toEqual(['after']);
    expect(logger.error).toHaveBeenCalledWith(
      'Shutdown: failed to close flaky',
      expect.any(Error),
    );
  });

  it('is idempotent: a second signal is a no-op', async () => {
    const closer = vi.fn();
    const shutdown = createGracefulShutdown({
      logger: fakeLogger(),
      server: fakeServer(),
      closers: [{ name: 'once', close: closer }],
    });

    await shutdown('SIGTERM');
    await shutdown('SIGTERM');

    expect(closer).toHaveBeenCalledTimes(1);
  });

  it('fires onTimeout if shutdown exceeds the deadline', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const shutdown = createGracefulShutdown({
      logger: fakeLogger(),
      server: fakeServer(),
      // never resolves -> deadline should fire
      closers: [{ name: 'hang', close: () => new Promise<void>(() => {}) }],
      timeoutMs: 1000,
      onTimeout,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
