import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { MailAdapter, MailMessage, MailLogger } from './types.js';
import type { MailConfig } from './config.js';

/**
 * The minimal SES surface the adapter calls. Declared as an interface so tests
 * can inject a fake client (verifying the constructed command) without touching
 * AWS, and so the default factory's concrete SESClient is the only place the SDK
 * is constructed.
 */
export interface SesLike {
  send(command: SendEmailCommand): Promise<unknown>;
}

/**
 * Builds an SES client for a region, optionally fronted by an STS assume-role
 * hop (when the SES-sending account differs from the service account). Injectable
 * so tests bypass AWS entirely.
 */
export type SesClientFactory = (region: string, roleArn?: string) => Promise<SesLike>;

export interface SesMailAdapterOptions {
  /** Override SES client construction. Tests inject a fake; prod uses the default. */
  sesClientFactory?: SesClientFactory;
}

/**
 * AWS SES adapter. Optionally assumes a role via STS before constructing the SES
 * client — matches the legacy saga_api pattern where SES sits in a separate AWS
 * account. A fresh client is built per send for simplicity; if volume grows,
 * cache + refresh near credential expiry.
 */
export class SesMailAdapter implements MailAdapter {
  private readonly sesClientFactory: SesClientFactory;

  constructor(
    private readonly config: MailConfig,
    private readonly logger: MailLogger,
    options: SesMailAdapterOptions = {},
  ) {
    this.sesClientFactory = options.sesClientFactory ?? defaultSesClientFactory;
  }

  async send(msg: MailMessage): Promise<void> {
    const region = this.config.mailSesRegion;
    if (!region) {
      // A consumer's config validation should already guarantee this when
      // provider=ses; throwing here is defense-in-depth.
      throw new Error('SesMailAdapter: mailSesRegion is required when MAIL_PROVIDER=ses');
    }

    const client = await this.sesClientFactory(region, this.config.mailSesRoleArn);
    const command = new SendEmailCommand({
      Source: this.config.mailFromAddress,
      Destination: { ToAddresses: [msg.to] },
      Message: {
        Subject: { Charset: 'UTF-8', Data: msg.subject },
        Body: { Html: { Charset: 'UTF-8', Data: msg.html } },
      },
    });

    try {
      await client.send(command);
    } catch (err) {
      this.logger.error(`SesMailAdapter: send failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}

/** Default factory: a real SESClient, optionally with STS assume-role credentials. */
async function defaultSesClientFactory(region: string, roleArn?: string): Promise<SesLike> {
  if (!roleArn) return new SESClient({ region });

  const sts = new STSClient({ region });
  const resp = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'soa-mailer' }));
  const creds = resp.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error('SesMailAdapter: STS assume-role returned no usable credentials');
  }
  return new SESClient({
    region,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });
}
