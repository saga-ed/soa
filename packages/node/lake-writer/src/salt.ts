// Loads the shared HMAC salt used across every pseudonymisation call in
// this package. NEVER log the resolved salt value, and never include it
// in an error message — every throw below names the *source* (secret id
// / env var) that failed, never the value.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** The production Secrets Manager id every fixtures CLI reads today. */
export const DEFAULT_SALT_SECRET_ID = 'sds/pseudonymization/salt-prod';

export interface LoadSaltOptions {
  /** Explicit salt value — highest precedence. Intended for tests. */
  salt?: string;
  /** Secrets Manager secret id to read when no explicit/env salt is given. */
  secretId?: string;
  /** AWS region for the Secrets Manager client. Defaults to `env.AWS_REGION ?? 'us-west-2'`. */
  region?: string;
  /** Inject a pre-built client (tests, or a caller with its own client lifecycle). */
  client?: SecretsManagerClient;
  /** Override the environment read for `LAKE_SALT` / `LAKE_SALT_SECRET_ID`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the pseudonymisation salt. Precedence:
 *
 *   1. `opts.salt` — explicit value, e.g. threaded through from a
 *      caller's own config.
 *   2. `env.LAKE_SALT` — intended for LOCAL / DEV / TEST use only; never
 *      set this in a deployed environment carrying real lake writes.
 *   3. AWS Secrets Manager `GetSecretValue` on
 *      `opts.secretId ?? env.LAKE_SALT_SECRET_ID ?? DEFAULT_SALT_SECRET_ID`.
 *
 * Throws (without ever including the salt value) if the resolved secret
 * has no `SecretString`.
 */
export async function loadSalt(opts: LoadSaltOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;

  if (opts.salt != null) return opts.salt;

  const envSalt = env.LAKE_SALT;
  if (envSalt != null && envSalt !== '') return envSalt;

  const secretId = opts.secretId ?? env.LAKE_SALT_SECRET_ID ?? DEFAULT_SALT_SECRET_ID;
  const region = opts.region ?? env.AWS_REGION ?? 'us-west-2';
  const client = opts.client ?? new SecretsManagerClient({ region });

  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = out.SecretString;
  if (!value) {
    throw new Error(`loadSalt: Secrets Manager secret "${secretId}" has no SecretString`);
  }
  return value;
}
