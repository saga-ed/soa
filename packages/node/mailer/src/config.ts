import { z } from 'zod';

/**
 * Mail provider configuration.
 *
 * MAIL_PROVIDER selects the runtime adapter:
 *   - 'stub' — log-only ({@link StubMailAdapter}); the default, safe for dev/test.
 *   - 'ses'  — AWS SES ({@link SesMailAdapter}); requires MAIL_SES_REGION.
 *   - 'capture' — writes each message to S3 ({@link CaptureMailAdapter}); requires
 *     MAIL_CAPTURE_BUCKET and MAIL_CAPTURE_PREFIX (no defaults).
 *
 * MAIL_PROVIDER unset defaults to 'stub' with a deprecation warning; it becomes
 * required in 2.0 (soa#515).
 *
 * MAIL_FROM_ADDRESS is the verified sender address (e.g. noreply@sagaeducation.org).
 * MAIL_SES_REGION is the AWS region for the SES client (required when provider=ses).
 * MAIL_SES_ROLE_ARN is optional; when set, STS assume-role is used before SES.
 *
 * Service-specific knobs (e.g. a frontend base URL for links) are NOT part of
 * this shared config — they belong to the consuming service's own config.
 */
export const MailConfigSchema = z
  .object({
  mailProvider: z.enum(['stub', 'ses', 'capture']).default('stub'),
  mailFromAddress: z.string().email().default('noreply@sagaeducation.org'),
  mailSesRegion: z.string().optional(),
  mailSesRoleArn: z.string().optional(),
  mailCaptureBucket: z.string().min(1).optional(),
  mailCapturePrefix: z.string().min(1).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.mailProvider !== 'capture') return;
    for (const key of ['mailCaptureBucket', 'mailCapturePrefix'] as const) {
      if (!cfg[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when mailProvider=capture` });
      }
    }
  });

export type MailConfig = z.infer<typeof MailConfigSchema>;

/**
 * Build a {@link MailConfig} from environment variables. Consumers may use this
 * directly or fold these keys into their own larger config schema. Unset keys
 * fall back to the stub-safe defaults.
 */
let providerDefaultWarned = false;

/** Test-only: re-arm the once-per-process MAIL_PROVIDER warning. */
export function resetMailProviderDefaultWarning(): void {
  providerDefaultWarned = false;
}

export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const input: Record<string, unknown> = {};
  if (env.MAIL_PROVIDER === undefined && !providerDefaultWarned) {
    providerDefaultWarned = true;
    process.emitWarning(
      'MAIL_PROVIDER unset; defaulting to stub; it becomes required in 2.0 (soa#515)',
      { type: 'DeprecationWarning', code: 'SOA_ENV_MAIL_PROVIDER_DEFAULT' },
    );
  }
  if (env.MAIL_PROVIDER !== undefined) input.mailProvider = env.MAIL_PROVIDER;
  if (env.MAIL_FROM_ADDRESS !== undefined) input.mailFromAddress = env.MAIL_FROM_ADDRESS;
  if (env.MAIL_SES_REGION !== undefined) input.mailSesRegion = env.MAIL_SES_REGION;
  if (env.MAIL_SES_ROLE_ARN !== undefined) input.mailSesRoleArn = env.MAIL_SES_ROLE_ARN;
  if (env.MAIL_CAPTURE_BUCKET !== undefined) input.mailCaptureBucket = env.MAIL_CAPTURE_BUCKET;
  if (env.MAIL_CAPTURE_PREFIX !== undefined) input.mailCapturePrefix = env.MAIL_CAPTURE_PREFIX;
  return MailConfigSchema.parse(input);
}
