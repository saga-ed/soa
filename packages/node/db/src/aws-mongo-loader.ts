import {
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { MongoProviderConfig } from './mongo-provider-config.js';

/**
 * Build a fully-resolved {@link MongoProviderConfig} by reading the SSM +
 * Secrets Manager primitives published by Saga's iac
 * (`cloudformation_templates/dbs/mongodb_shared/`).
 *
 * Two scopes:
 *
 * - `'shared'` (default): staging or prod. Reads from
 *   `/shared/infra/{env}/mongodb-*` and Secrets Manager
 *   `{env}/mongodb-shared/{project}-password`, returns a config that
 *   authenticates as the per-service SCRAM user `{project}_app` against
 *   database `{project}_db`.
 *
 * - `'mirror-current'`: the prod-mirror in the dev account
 *   (`saga-mongodb-mirror-current`). Reads from
 *   `/mirror/current/mongodb-shared/*`, returns a config that
 *   authenticates as the master admin (per-service users on the mirror
 *   inherit prod's hashed passwords, which we don't have plaintext for).
 *   Caller-supplied `project` is used only to default the target database
 *   name; admin can read any DB.
 *
 * Dev (`db-host` per-service docker mongo) is intentionally NOT supported
 * by this loader — the per-service port mapping is not in SSM today. Dev
 * callers should construct {@link MongoProviderConfig} directly from
 * env vars or static wiring.
 */
export interface LoadMongoConfigParams {
  /** Mirror-current is the dev-account mirror; shared is staging/prod. */
  scope?: 'shared' | 'mirror-current';
  /** Required when scope is 'shared'. Ignored for 'mirror-current'. */
  env?: 'staging' | 'prod';
  /** Project name (e.g. 'ledger-api'). Hyphens become underscores in db/user names. */
  project: string;
  /** Name to give the MongoProvider instance. */
  instanceName: string;
  /** Override AWS region. Defaults to us-west-2 (Saga's only region). */
  region?: string;
}

const DEFAULT_REGION = 'us-west-2';

export async function loadMongoConfigFromAws(
  params: LoadMongoConfigParams,
): Promise<MongoProviderConfig> {
  const { project, instanceName } = params;
  const scope = params.scope ?? 'shared';
  const region = params.region ?? DEFAULT_REGION;

  const ssm = new SSMClient({ region });
  const sm = new SecretsManagerClient({ region });

  const dbName = `${project.replace(/-/g, '_')}_db`;

  if (scope === 'shared') {
    const env = params.env;
    if (env !== 'staging' && env !== 'prod') {
      throw new Error(`scope='shared' requires env='staging'|'prod', got: ${String(env)}`);
    }

    const [hostsCsv, replicaSetName, caSecretArn] = await Promise.all([
      readSsm(ssm, `/shared/infra/${env}/mongodb-hosts`),
      readSsm(ssm, `/shared/infra/${env}/mongodb-replica-set-name`),
      readSsm(ssm, `/shared/infra/${env}/mongodb-ca-secret-arn`),
    ]);

    const [caBundle, projectCreds] = await Promise.all([
      readSecretJson<{ ca_cert: string }>(sm, caSecretArn),
      readSecretJson<{ username: string; password: string }>(
        sm,
        `${env}/mongodb-shared/${project}-password`,
      ),
    ]);

    return {
      configType: 'MONGO',
      instanceName,
      hosts: splitHosts(hostsCsv),
      database: dbName,
      username: projectCreds.username,
      password: projectCreds.password,
      replicaSet: replicaSetName,
      authSource: dbName,
      tls: true,
      tlsCAContent: caBundle.ca_cert,
    };
  }

  // scope === 'mirror-current'
  const [endpoint, port, replicaSetName, caSecretArn, masterSecretArn] =
    await Promise.all([
      readSsm(ssm, '/mirror/current/mongodb-shared/endpoint'),
      readSsm(ssm, '/mirror/current/mongodb-shared/port'),
      readSsm(ssm, '/mirror/current/mongodb-shared/replica-set-name'),
      readSsm(ssm, '/mirror/current/mongodb-shared/ca-secret-arn'),
      readSsm(ssm, '/mirror/current/mongodb-shared/master-secret-arn'),
    ]);

  const [caBundle, masterCreds] = await Promise.all([
    readSecretJson<{ ca_cert: string }>(sm, caSecretArn),
    readSecretJson<{ username: string; password: string }>(sm, masterSecretArn),
  ]);

  return {
    configType: 'MONGO',
    instanceName,
    hosts: [`${endpoint}:${port}`],
    database: dbName,
    username: masterCreds.username,
    password: masterCreds.password,
    replicaSet: replicaSetName,
    // Master user lives in admin DB (created via localhost exception during
    // RS bootstrap), not in the per-project DB.
    authSource: 'admin',
    tls: true,
    tlsCAContent: caBundle.ca_cert,
  };
}

async function readSsm(client: SSMClient, name: string): Promise<string> {
  const out = await client.send(new GetParameterCommand({ Name: name }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} has no value`);
  return value;
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

function splitHosts(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
