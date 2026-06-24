import type { MailAdapter, MailMessage } from './types.js';

/**
 * The fleet's mail entry point. Wraps whichever {@link MailAdapter} a service
 * wired (stub in dev, SES in prod) behind a single `send`. Intentionally generic
 * — it owns no templates. Service-specific bodies (verification codes, password
 * resets, sync digests, …) are composed by the consuming service, which calls
 * `send` with a finished {@link MailMessage}.
 */
export class MailService {
  constructor(private readonly adapter: MailAdapter) {}

  send(msg: MailMessage): Promise<void> {
    return this.adapter.send(msg);
  }
}
