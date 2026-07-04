/**
 * Core mail contracts shared across the fleet.
 *
 * Kept deliberately small: one message shape, one adapter seam, and a
 * structural logger so the package never has to depend on a concrete logger
 * implementation (any `@saga-ed/soa-logger` ILogger satisfies MailLogger).
 */

/** A single transactional email to send. */
export interface MailMessage {
  to: string;
  subject: string;
  /** Raw HTML body. A plain-text fallback is derived by the adapter when needed. */
  html: string;
}

/**
 * The provider seam. `MailService` wraps one of these; callers never see it
 * directly. Ship adapters: {@link StubMailAdapter} (dev/test, logs only) and
 * {@link SesMailAdapter} (AWS SES, prod).
 */
export interface MailAdapter {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Structural logger the adapters write to. A subset of `@saga-ed/soa-logger`'s
 * ILogger, declared locally so this package carries no logger dependency — any
 * ILogger instance is assignable.
 */
export interface MailLogger {
  info(message: string): void;
  error(message: string): void;
}
