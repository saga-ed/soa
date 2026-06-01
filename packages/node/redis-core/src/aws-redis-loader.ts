import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { RedisConfig } from './redis-connection-manager.js';

/**
 * Build a {@link RedisConfig} for a per-service ElastiCache user.
 *
 * Reads the secret written by ``saga-provision-credentials`` at
 * ``{env}/redis/{service}`` (shape:
 * ``{username, password, endpoint, port, tls, user_group_id}``).
 * The endpoint may also be sourced from SSM
 * ``/shared/infra/{env}/redis-endpoint`` if the secret omits it, but in
 * practice the CLI writes it into the secret so SSM is a fallback.
 *
 * Per-service users are attached to the env's user group
 * (``cache-{env}``) which is bound to the replication group at the
 * IaC level. Each user has a key-pattern-scoped AccessString (e.g.,
 * ``on ~{service}:* +@read +@write -@dangerous``) so server-side
 * enforcement prevents cross-service reads/writes.
 *
 * Env support:
 *
 * - `'dev'`    — local container or `cache-dev` if it ever comes back.
 *                Today most dev usage skips authentication and goes
 *                through SG membership only; the CLI's `--insecure-dev`
 *                path writes a parity secret so consumers can construct
 *                this config uniformly across envs.
 * - `'mirror'` — `cache-mirror` user group in account 396.
 * - `'prod'`   — `cache-prod` user group in account 531.
 */
export interface LoadRedisConfigParams {
  env: 'dev' | 'mirror' | 'prod';
  /** Service name as in `db-access.yaml` (e.g. 'sds-api'). */
  service: string;
  /** Override AWS region. Defaults to us-west-2. */
  region?: string;
}

const DEFAULT_REGION = 'us-west-2';

interface RedisSecretPayload {
  username: string;
  password: string;
  endpoint?: string;
  port?: number | string;
  tls?: boolean;
  user_group_id?: string;
}

export async function loadRedisConfigFromAws(
  params: LoadRedisConfigParams,
): Promise<RedisConfig> {
  const region = params.region ?? DEFAULT_REGION;
  const sm = new SecretsManagerClient({ region });
  const ssm = new SSMClient({ region });

  const secretId = `${params.env}/redis/${params.service}`;
  const raw = await readSecretJson<RedisSecretPayload>(sm, secretId);

  // Endpoint is normally in the secret; fall back to SSM if not (older
  // provisioning runs predate that field).
  let endpoint = raw.endpoint;
  if (!endpoint) {
    endpoint = await readSsm(ssm, `/shared/infra/${params.env}/redis-endpoint`);
  }

  return {
    url: endpoint,
    username: raw.username,
    password: raw.password,
    tls: raw.tls ?? params.env !== 'dev',
  };
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

async function readSsm(client: SSMClient, name: string): Promise<string> {
  const out = await client.send(new GetParameterCommand({ Name: name }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} has no value`);
  return value;
}
