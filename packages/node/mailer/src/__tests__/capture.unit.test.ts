import { afterEach, describe, expect, it, vi } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CaptureMailAdapter,
  MailConfigSchema,
  SesMailAdapter,
  createS3CaptureWriter,
  loadMailConfig,
  type CapturedMail,
  type MailLogger,
} from '../index.js';
import { resetMailProviderDefaultWarning } from '../config.js';

const MSG = { to: 'a@b.com', subject: 'Hi', html: '<b>hi</b>' };

describe('CaptureMailAdapter', () => {
  it('writes exactly one record and never touches SES', async () => {
    const write = vi.fn(async (_r: CapturedMail) => {});
    const sesFactory = vi.fn();
    new SesMailAdapter(
      MailConfigSchema.parse({ mailProvider: 'ses', mailSesRegion: 'us-west-2' }),
      { info: vi.fn(), error: vi.fn() } satisfies MailLogger,
      { sesClientFactory: sesFactory },
    );
    const adapter = new CaptureMailAdapter({ write }, { from: 'noreply@x.org', now: () => new Date('2026-01-02T03:04:05.000Z') });
    await adapter.send(MSG);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toEqual({
      to: 'a@b.com',
      from: 'noreply@x.org',
      subject: 'Hi',
      html: '<b>hi</b>',
      capturedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(sesFactory).not.toHaveBeenCalled();
  });
});

describe('createS3CaptureWriter', () => {
  it('PutObjects <prefix>/<capturedAt>-<uuid>.json as application/json', async () => {
    const send = vi.fn(async (_c: PutObjectCommand) => ({}));
    const writer = createS3CaptureWriter({ bucket: 'bkt', prefix: 'mail/run1/', client: { send } });
    const record: CapturedMail = { ...MSG, capturedAt: '2026-01-02T03:04:05.000Z' };
    await writer.write(record);
    const input = send.mock.calls[0]![0].input;
    expect(input.Bucket).toBe('bkt');
    expect(input.Key).toMatch(/^mail\/run1\/2026-01-02T03:04:05\.000Z-[0-9a-f-]{36}\.json$/);
    expect(input.ContentType).toBe('application/json');
    expect(JSON.parse(input.Body as string)).toEqual(record);
  });
});

describe('capture config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMailProviderDefaultWarning();
  });

  it('refuses provider=capture without bucket and prefix', () => {
    const r = MailConfigSchema.safeParse({ mailProvider: 'capture' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain('mailCaptureBucket');
    expect(JSON.stringify(r.error!.issues)).toContain('mailCapturePrefix');
    expect(MailConfigSchema.safeParse({ mailProvider: 'capture', mailCaptureBucket: 'b', mailCapturePrefix: 'p' }).success).toBe(true);
  });

  it('loads capture keys from env', () => {
    const cfg = loadMailConfig({ MAIL_PROVIDER: 'capture', MAIL_CAPTURE_BUCKET: 'b', MAIL_CAPTURE_PREFIX: 'p' });
    expect(cfg).toMatchObject({ mailProvider: 'capture', mailCaptureBucket: 'b', mailCapturePrefix: 'p' });
  });

  it('unset MAIL_PROVIDER defaults to stub and warns exactly once', () => {
    const warn = vi.spyOn(process, 'emitWarning');
    expect(loadMailConfig({}).mailProvider).toBe('stub');
    expect(loadMailConfig({}).mailProvider).toBe('stub');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('soa#515'), {
      type: 'DeprecationWarning',
      code: 'SOA_ENV_MAIL_PROVIDER_DEFAULT',
    });
  });

  it('set MAIL_PROVIDER does not warn', () => {
    const warn = vi.spyOn(process, 'emitWarning');
    loadMailConfig({ MAIL_PROVIDER: 'stub' });
    expect(warn).not.toHaveBeenCalled();
  });
});
