import type { BootstrapLogger } from './types.js';

/** A single resource to tear down during shutdown. */
export interface Closer {
  name: string;
  /** Best-effort close. May throw / reject — the harness logs and continues. */
  close: () => Promise<void> | void;
}

/** Just the slice of `http.Server` the harness needs (keeps it test-friendly). */
export interface ClosableServer {
  close(callback?: (err?: Error) => void): void;
}

export interface GracefulShutdownOptions {
  logger: BootstrapLogger;
  /** The HTTP server — closed first so no new requests are accepted. */
  server: ClosableServer;
  /**
   * Resources closed (in order) after the HTTP server, best-effort: a throwing
   * closer is logged and the rest still run. Order matters — list dependents
   * before their dependencies (e.g. outbox relay before the DB pool, tracing
   * flush last).
   */
  closers?: readonly Closer[];
  /** Force-exit deadline. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Called if the deadline fires before shutdown completes (default: `process.exit(1)`). */
  onTimeout?: () => void;
}

function makeTryClose(logger: BootstrapLogger) {
  return async function tryClose(
    name: string,
    close: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await close();
    } catch (err) {
      logger.error(
        `Shutdown: failed to close ${name}`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  };
}

/**
 * Build the idempotent shutdown routine: close the HTTP server, then each
 * closer in order (best-effort), guarded by a force-exit deadline. Returns the
 * routine WITHOUT registering any signal handlers or calling `process.exit` —
 * so it can be unit-tested directly. Use {@link installGracefulShutdown} to
 * wire it to SIGTERM/SIGINT.
 */
export function createGracefulShutdown(
  opts: GracefulShutdownOptions,
): (signal: string) => Promise<void> {
  const { logger, server } = opts;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const closers = opts.closers ?? [];
  const tryClose = makeTryClose(logger);
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal} — shutting down gracefully...`);

    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      (opts.onTimeout ?? (() => process.exit(1)))();
    }, timeoutMs);
    // Don't let the deadline timer keep the event loop alive.
    if (typeof timer.unref === 'function') timer.unref();

    await tryClose(
      'http server',
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    for (const c of closers) {
      await tryClose(c.name, c.close);
    }

    clearTimeout(timer);
    logger.info('Shutdown complete');
  };
}

/**
 * Register {@link createGracefulShutdown} against process signals (default
 * SIGTERM + SIGINT); on completion the process exits 0. Returns the shutdown
 * routine (handy for tests / manual invocation).
 */
export function installGracefulShutdown(
  opts: GracefulShutdownOptions & { signals?: readonly NodeJS.Signals[] },
): (signal: string) => Promise<void> {
  const shutdown = createGracefulShutdown(opts);
  const signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  for (const sig of signals) {
    process.on(sig, () => {
      void shutdown(sig).then(() => process.exit(0));
    });
  }
  return shutdown;
}
