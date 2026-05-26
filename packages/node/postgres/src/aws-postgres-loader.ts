import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { PostgresProviderSchema } from './postgres-provider-config.js';
import type { PostgresProviderConfig } from './postgres-provider-config.js';

/**
 * Build a fully-resolved {@link PostgresProviderConfig} by reading the
 * Secrets Manager payload written by ``saga-provision-credentials``.
 *
 * The CLI writes one secret per service per env at
 * ``{env}/postgres-shared/{service}`` with shape
 * ``{username, password, host, port, database, engine}``. That's the
 * full set of fields we need — no SSM read is required for postgres
 * (host is in the secret, port is in the secret, no TLS CA needed
 * because RDS uses public trust anchors).
 *
 * Env mapping:
 *
 * - `'dev'`   — db-host container in dev account. The CLI's
 *               ``--insecure-dev`` mode writes a parity secret with
 *               trivial password and ``host: db-host.dbs``.
 * - `'mirror'` — prod-shape RDS in dev account (account 396).
 *                ``ssl: true`` always (managed RDS).
 * - `'prod'`   — prod RDS in account 531. ``ssl: true`` always.
 *
 * For dev (where the local container is unauthenticated), callers
 * can construct {@link PostgresProviderConfig} directly from env vars
 * if the parity secret hasn't been provisioned.
 */
export interface LoadPostgresConfigParams {
  env: 'dev' | 'mirror' | 'prod';
  /** Service name as it appears in `db-access.yaml` (e.g. 'sds-api'). */
  service: string;
  /** Name to give the PostgresProvider instance. */
  instanceName: string;
  /** Override AWS region. Defaults to us-west-2. */
  region?: string;
}

const DEFAULT_REGION = 'us-west-2';

export async function loadPostgresConfigFromAws(
  params: LoadPostgresConfigParams,
): Promise<PostgresProviderConfig> {
  const region = params.region ?? DEFAULT_REGION;
  const sm = new SecretsManagerClient({ region });

  const secretId = `${params.env}/postgres-shared/${params.service}`;
  const raw = await readSecretJson<{
    username: string;
    password: string;
    host: string;
    port: number | string;
    database: string;
    engine?: string;
  }>(sm, secretId);

  // mirror + prod are always managed RDS — SSL required.
  // dev is the db-host container with no TLS.
  const ssl = params.env !== 'dev';

  return PostgresProviderSchema.parse({
    instanceName: params.instanceName,
    host: raw.host,
    port: typeof raw.port === 'string' ? parseInt(raw.port, 10) : raw.port,
    database: raw.database,
    username: raw.username,
    password: raw.password,
    ssl,
  });
}

async function readSecretJson<T>(
  client: SecretsManagerClient,
  secretId: string,
): Promise<T> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString`);
  }
  return JSON.parse(out.SecretString) as T;
}
