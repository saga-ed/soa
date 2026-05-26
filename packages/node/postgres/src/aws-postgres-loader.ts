import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { PostgresProviderSchema } from './postgres-provider-config.js';
import type { PostgresProviderConfig } from './postgres-provider-config.js';

/**
 * Build a fully-resolved {@link PostgresProviderConfig} by reading the
 * Secrets Manager payload written by ``saga-provision-credentials`` (prod)
 * or by the daily mirror refresh workflow (mirror).
 *
 * Secret paths are env-specific:
 *
 * - `'dev'`   — db-host container in dev account. CLI's ``--insecure-dev``
 *               writes a parity secret with trivial password and ``host: db-host.dbs``.
 *               Path: ``dev/postgres-shared/{service}[-{dbId}]``.
 * - `'mirror'` — prod-shape RDS in dev account, refreshed daily from a prod
 *                snapshot. Path matches the existing refresh workflow:
 *                ``/mirror/current/{service}-postgres-password`` (leading slash;
 *                ``-postgres-password`` suffix). For multi-DB services the
 *                ``dbId`` goes BEFORE the suffix:
 *                ``/mirror/current/{service}-{dbId}-postgres-password``.
 * - `'prod'`   — prod RDS in account 531. SSL required.
 *                Path: ``prod/postgres-shared/{service}[-{dbId}]``.
 *
 * Payload shape (both workflow and CLI write the same fields, with one
 * legacy quirk — the mirror workflow uses ``dbname`` while the CLI uses
 * ``database``. Loader accepts either.)
 *
 *   { username, password, host, port, database (or dbname), engine? }
 *
 * Multi-DB postgres services (e.g., rostering's iam-api with iam_db +
 * iam_pii_db) pass ``dbId`` to address each DB's credential separately.
 */
export interface LoadPostgresConfigParams {
  env: 'dev' | 'mirror' | 'prod';
  /** Service name as it appears in `db-access.yaml` (e.g. 'iam-api'). */
  service: string;
  /** Name to give the PostgresProvider instance. */
  instanceName: string;
  /**
   * For multi-DB services, the database id from db-access.yaml (e.g. 'main',
   * 'pii'). Omit for single-DB services — the secret path uses the bare
   * service name with no suffix.
   */
  dbId?: string;
  /** Override AWS region. Defaults to us-west-2. */
  region?: string;
}

const DEFAULT_REGION = 'us-west-2';

export async function loadPostgresConfigFromAws(
  params: LoadPostgresConfigParams,
): Promise<PostgresProviderConfig> {
  const region = params.region ?? DEFAULT_REGION;
  const sm = new SecretsManagerClient({ region });

  const secretId = postgresServiceSecretName(params.env, params.service, params.dbId);
  const raw = await readSecretJson<{
    username: string;
    password: string;
    host: string;
    port: number | string;
    database?: string;
    dbname?: string;
    engine?: string;
  }>(sm, secretId);

  // mirror + prod are always managed RDS — SSL required.
  // dev is the db-host container with no TLS.
  const ssl = params.env !== 'dev';

  // Accept either `database` (CLI / prod) or `dbname` (mirror refresh workflow).
  const database = raw.database ?? raw.dbname;
  if (!database) {
    throw new Error(
      `Secret ${secretId} is missing both 'database' and 'dbname' fields`,
    );
  }

  return PostgresProviderSchema.parse({
    instanceName: params.instanceName,
    host: raw.host,
    port: typeof raw.port === 'string' ? parseInt(raw.port, 10) : raw.port,
    database,
    username: raw.username,
    password: raw.password,
    ssl,
  });
}

/**
 * Compute the canonical SM secret name for a postgres service / env / dbId.
 *
 * Mirror paths align with the existing refresh workflow shape so the CLI
 * and the workflow write to the same location:
 *
 *   single-DB:  /mirror/current/{service}-postgres-password
 *   multi-DB:   /mirror/current/{service}-{dbId}-postgres-password
 *
 * Prod/dev use our CLI's path shape:
 *
 *   single-DB:  {env}/postgres-shared/{service}
 *   multi-DB:   {env}/postgres-shared/{service}-{dbId}
 */
export function postgresServiceSecretName(
  env: 'dev' | 'mirror' | 'prod',
  service: string,
  dbId?: string,
): string {
  if (env === 'mirror') {
    const idPart = dbId ? `-${dbId}` : '';
    return `/mirror/current/${service}${idPart}-postgres-password`;
  }
  const idPart = dbId ? `-${dbId}` : '';
  return `${env}/postgres-shared/${service}${idPart}`;
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
