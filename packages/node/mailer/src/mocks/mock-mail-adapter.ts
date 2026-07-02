import type { MailAdapter, MailMessage } from '../types.js';

/**
 * Test double — records every message instead of sending. Consumers use it to
 * assert what a service would email, without a logger or AWS. Import from
 * `@saga-ed/soa-mailer/mocks`.
 */
export class MockMailAdapter implements MailAdapter {
  readonly sent: MailMessage[] = [];
  /** Set to make the next send reject (exercise consumer error handling). */
  failNext: Error | null = null;

  async send(msg: MailMessage): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.sent.push(msg);
  }

  /** Clear recorded messages between assertions. */
  reset(): void {
    this.sent.length = 0;
    this.failNext = null;
  }
}
