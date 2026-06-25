/**
 * Minimal structural logger the bootstrap helpers depend on.
 *
 * Deliberately NOT `@saga-ed/soa-logger`'s `ILogger` — a structural subset so
 * this package doesn't pin a logger version and any compatible logger (Pino
 * wrapper, console, a test spy) satisfies it.
 */
export interface BootstrapLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
