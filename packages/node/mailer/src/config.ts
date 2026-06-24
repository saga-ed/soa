import { z } from 'zod';

/**
 * Mail provider configuration.
 *
 * MAIL_PROVIDER selects the runtime adapter:
 *   - 'stub' — log-only ({@link StubMailAdapter}); the default, safe for dev/test.
 *   - 'ses'  — AWS SES ({@link SesMailAdapter}); requires MAIL_SES_REGION.
 *
 * MAIL_FROM_ADDRESS is the verified sender address (e.g. noreply@sagaeducation.org).
 * MAIL_SES_REGION is the AWS region for the SES client (required when provider=ses).
 * MAIL_SES_ROLE_ARN is optional; when set, STS assume-role is used before SES.
 *
 * Service-specific knobs (e.g. a frontend base URL for links) are NOT part of
 * this shared config — they belong to the consuming service's own config.
 */
export const MailConfigSchema = z.object({
  mailProvider: z.enum(['stub', 'ses']).default('stub'),
  mailFromAddress: z.string().email().default('noreply@sagaeducation.org'),
  mailSesRegion: z.string().optional(),
  mailSesRoleArn: z.string().optional(),
});

export type MailConfig = z.infer<typeof MailConfigSchema>;

/**
 * Build a {@link MailConfig} from environment variables. Consumers may use this
 * directly or fold these keys into their own larger config schema. Unset keys
 * fall back to the stub-safe defaults.
 */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const input: Record<string, unknown> = {};
  if (env.MAIL_PROVIDER !== undefined) input.mailProvider = env.MAIL_PROVIDER;
  if (env.MAIL_FROM_ADDRESS !== undefined) input.mailFromAddress = env.MAIL_FROM_ADDRESS;
  if (env.MAIL_SES_REGION !== undefined) input.mailSesRegion = env.MAIL_SES_REGION;
  if (env.MAIL_SES_ROLE_ARN !== undefined) input.mailSesRoleArn = env.MAIL_SES_ROLE_ARN;
  return MailConfigSchema.parse(input);
}
