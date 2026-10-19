import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MailAdapter, MailMessage } from './types.js';

/** JSON shape persisted for every captured message. */
export interface CapturedMail {
  to: string;
  from?: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
  capturedAt: string;
}

export interface CaptureWriter {
  write(record: CapturedMail): Promise<void>;
}

export interface CaptureMailAdapterOptions {
  /** Sender recorded on each captured record. */
  from?: string;
  headers?: Record<string, string>;
  now?: () => Date;
}

/** Records messages through a {@link CaptureWriter}; never contacts a recipient. */
export class CaptureMailAdapter implements MailAdapter {
  constructor(
    private readonly writer: CaptureWriter,
    private readonly options: CaptureMailAdapterOptions = {},
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const record: CapturedMail = {
      to: msg.to,
      ...(this.options.from ? { from: this.options.from } : {}),
      subject: msg.subject,
      html: msg.html,
      ...(this.options.headers ? { headers: this.options.headers } : {}),
      capturedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    await this.writer.write(record);
  }
}

/** The minimal S3 surface the writer calls. */
export interface S3Like {
  send(command: PutObjectCommand): Promise<unknown>;
}

export interface S3CaptureWriterOptions {
  bucket: string;
  prefix: string;
  client?: S3Like;
  region?: string;
}

/** Writes each record to `<prefix>/<capturedAt>-<uuid>.json`. */
export function createS3CaptureWriter(opts: S3CaptureWriterOptions): CaptureWriter {
  const client: S3Like = opts.client ?? new S3Client({ region: opts.region });
  const prefix = opts.prefix.replace(/\/+$/, '');
  return {
    async write(record) {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: `${prefix}/${record.capturedAt}-${randomUUID()}.json`,
          Body: JSON.stringify(record),
          ContentType: 'application/json',
        }),
      );
    },
  };
}
