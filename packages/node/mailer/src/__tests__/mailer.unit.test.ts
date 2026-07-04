import { describe, it, expect, vi } from 'vitest';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import {
  MailService,
  StubMailAdapter,
  SesMailAdapter,
  MockMailAdapter,
  MailConfigSchema,
  loadMailConfig,
  type MailConfig,
  type MailLogger,
  type SesLike,
} from '../index.js';

function logger(): MailLogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() };
}

const MSG = { to: 'a@b.com', subject: 'Hi', html: '<b>hi</b>' };

describe('MailService', () => {
  it('delegates send to the wired adapter', async () => {
    const mock = new MockMailAdapter();
    await new MailService(mock).send(MSG);
    expect(mock.sent).toEqual([MSG]);
  });
});

describe('StubMailAdapter', () => {
  it('logs the full payload on one line under mail-stub: and never throws', async () => {
    const log = logger();
    await new StubMailAdapter(log).send(MSG);
    expect(log.info).toHaveBeenCalledTimes(1);
    const line = log.info.mock.calls[0][0] as string;
    expect(line).toContain('mail-stub:');
    expect(line).toContain('to=a@b.com');
    expect(line).toContain('<b>hi</b>');
  });
});

describe('MockMailAdapter', () => {
  it('records messages and can be reset', async () => {
    const mock = new MockMailAdapter();
    await mock.send(MSG);
    await mock.send({ ...MSG, to: 'c@d.com' });
    expect(mock.sent.map((m) => m.to)).toEqual(['a@b.com', 'c@d.com']);
    mock.reset();
    expect(mock.sent).toEqual([]);
  });

  it('rejects once when failNext is set, then resumes recording', async () => {
    const mock = new MockMailAdapter();
    mock.failNext = new Error('boom');
    await expect(mock.send(MSG)).rejects.toThrow('boom');
    await mock.send(MSG); // failNext cleared
    expect(mock.sent).toEqual([MSG]);
  });
});

describe('MailConfig', () => {
  it('defaults to the stub-safe provider with the Saga sender', () => {
    const cfg = MailConfigSchema.parse({});
    expect(cfg.mailProvider).toBe('stub');
    expect(cfg.mailFromAddress).toBe('noreply@sagaeducation.org');
  });

  it('loadMailConfig reads the MAIL_* env vars', () => {
    const cfg = loadMailConfig({ MAIL_PROVIDER: 'ses', MAIL_SES_REGION: 'us-west-2', MAIL_FROM_ADDRESS: 'x@saga.org' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ mailProvider: 'ses', mailSesRegion: 'us-west-2', mailFromAddress: 'x@saga.org' });
  });

  it('rejects a non-email from address', () => {
    expect(() => MailConfigSchema.parse({ mailFromAddress: 'not-an-email' })).toThrow();
  });
});

describe('SesMailAdapter', () => {
  const sesConfig: MailConfig = { mailProvider: 'ses', mailFromAddress: 'from@saga.org', mailSesRegion: 'us-west-2' };

  it('builds a SendEmailCommand with the configured source + recipient and sends it', async () => {
    let captured: SendEmailCommand | undefined;
    const fake: SesLike = { send: async (cmd) => ((captured = cmd), {}) };
    const adapter = new SesMailAdapter(sesConfig, logger(), { sesClientFactory: async () => fake });

    await adapter.send(MSG);

    expect(captured).toBeInstanceOf(SendEmailCommand);
    expect(captured!.input.Source).toBe('from@saga.org');
    expect(captured!.input.Destination?.ToAddresses).toEqual(['a@b.com']);
    expect(captured!.input.Message?.Subject?.Data).toBe('Hi');
    expect(captured!.input.Message?.Body?.Html?.Data).toBe('<b>hi</b>');
  });

  it('passes the role arn through to the client factory when set', async () => {
    const factory = vi.fn(async () => ({ send: async () => ({}) }) as SesLike);
    await new SesMailAdapter({ ...sesConfig, mailSesRoleArn: 'arn:aws:iam::1:role/x' }, logger(), { sesClientFactory: factory }).send(MSG);
    expect(factory).toHaveBeenCalledWith('us-west-2', 'arn:aws:iam::1:role/x');
  });

  it('throws (defense-in-depth) when region is missing', async () => {
    const adapter = new SesMailAdapter({ ...sesConfig, mailSesRegion: undefined }, logger(), { sesClientFactory: async () => ({ send: async () => ({}) }) });
    await expect(adapter.send(MSG)).rejects.toThrow(/mailSesRegion is required/);
  });

  it('logs and rethrows when the SES send fails', async () => {
    const log = logger();
    const fake: SesLike = { send: async () => { throw new Error('SES down'); } };
    await expect(new SesMailAdapter(sesConfig, log, { sesClientFactory: async () => fake }).send(MSG)).rejects.toThrow('SES down');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('SES down'));
  });
});
