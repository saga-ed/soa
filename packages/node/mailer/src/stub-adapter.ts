import type { MailAdapter, MailMessage, MailLogger } from './types.js';

/**
 * Dev / test adapter — logs the email payload (recipient, subject, body) to the
 * provided logger instead of sending. The whole send shows up on one line under
 * `mail-stub:` for trivial dev grep / E2E assertion.
 *
 * NEVER ship to production: any sensitive content in the body (codes, links)
 * lands in logs. Consuming services should refuse to boot with provider=stub in
 * production (their startup check, not this package's concern).
 */
export class StubMailAdapter implements MailAdapter {
  constructor(private readonly logger: MailLogger) {}

  async send(msg: MailMessage): Promise<void> {
    this.logger.info(`mail-stub: to=${msg.to} subject=${JSON.stringify(msg.subject)} body=${JSON.stringify(msg.html)}`);
  }
}
