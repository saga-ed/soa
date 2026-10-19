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
  /**
   * Explicit coordinates; replaces `scope` + `env` (passing either alongside
   * throws). Preferred form: no env name is inferred from the caller.
   */
  coords?: MongoCoords;
  /** @deprecated Use `coords`. Mirror-current is the dev-account mirror (admin); shared is mirror/prod. */
  scope?: 'shared' | 'mirror-current';
  /**
   * @deprecated Use `coords`. Required when scope is 'shared'. Ignored for 'mirror-current'.
   *
   * - `'mirror'` — canonical name for the prod-shape RDS-managed mirror.
   * - `'prod'`   — production.
   * - `'staging'` — deprecated alias for `'mirror'`; emits a warning.
   *                 Removed in next major.
   *
   * Until the SSM/Secrets-Manager rename ships, `'mirror'` resolves to
   * the same underlying paths as `'staging'` ({@link _STAGING_PATH_PREFIX}
   * below). This is a one-cycle compat shim.
   */
  env?: 'mirror' | 'prod' | 'staging';
  /** Project name (e.g. 'ledger-api'). Hyphens become underscores in db/user names. */
  project: string;
  /** Name to give the MongoProvider instance. */
  instanceName: string;
  /** Override AWS region. Defaults to us-west-2 (Saga's only region). */
  region?: string;
}

/**
 * - `shared`         - per-service SCRAM user from `{ssmPrefix}/mongodb-*` and
 *                      secret `{secretPrefix}/{project}-password`
 *                      (e.g. `/shared/infra/prod` + `prod/mongodb-shared`).
 * - `mirror-project` - per-service user on the dev-account mirror
 *                      (`/mirror/current/mongodb-shared/*`).
 * - `mirror-current` - master admin on the dev-account mirror.
 */
export type MongoCoords =
  | { kind: 'shared'; ssmPrefix: string; secretPrefix: string }
  | { kind: 'mirror-project' }
  | { kind: 'mirror-current' };

const DEFAULT_REGION = 'us-west-2';

const LEGACY_SHARED_ENV_COORDS: Record<'mirror' | 'prod' | 'staging', MongoCoords> = {
  mirror: { kind: 'mirror-project' },
  prod: { kind: 'shared', ssmPrefix: '/shared/infra/prod', secretPrefix: 'prod/mongodb-shared' },
  staging: {
    kind: 'shared',
    ssmPrefix: '/shared/infra/staging',
    secretPrefix: 'staging/mongodb-shared',
  },
};

let legacyEnvWarned = false;

function warnLegacyEnvOnce(): void {
  if (legacyEnvWarned) return;
  legacyEnvWarned = true;
  process.emitWarning(
    "loadMongoConfigFromAws: 'scope'/'env' are deprecated; pass 'coords' instead.",
    { type: 'DeprecationWarning', code: 'SOA_ENV_FALLBACK_MONGO_ENV' },
  );
}

function resolveCoords(params: LoadMongoConfigParams): MongoCoords {
  if (params.coords) {
    if (params.scope !== undefined || params.env !== undefined) {
      throw new Error("loadMongoConfigFromAws: 'coords' cannot be combined with 'scope'/'env'");
    }
    return params.coords;
  }

  warnLegacyEnvOnce();
  const scope = params.scope ?? 'shared';
  // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- deprecated fallback; remove once all consumers pass coords (soa#515)
  if (scope === 'mirror-current') return { kind: 'mirror-current' };

  const env = params.env;
  if (env === undefined || !Object.hasOwn(LEGACY_SHARED_ENV_COORDS, env)) {
    throw new Error(
      `scope='shared' requires env='mirror'|'prod' (or deprecated 'staging'), got: ${String(env)}`,
    );
  }
  // eslint-disable-next-line @saga-ed/soa-env/no-env-identity -- deprecated fallback; remove once all consumers pass coords (soa#515)
  if (env === 'staging') {
    // eslint-disable-next-line no-console
    console.warn(
      "[@saga-ed/soa-db] env='staging' is deprecated; use env='mirror'. " +
        "Will be removed in next major.",
    );
  }
  return LEGACY_SHARED_ENV_COORDS[env];
}

export async function loadMongoConfigFromAws(
  params: LoadMongoConfigParams,
): Promise<MongoProviderConfig> {
  const { project, instanceName } = params;
  const coords = resolveCoords(params);
  const region = params.region ?? DEFAULT_REGION;

  const ssm = new SSMClient({ region });
  const sm = new SecretsManagerClient({ region });

  const dbName = `${project.replace(/-/g, '_')}_db`;

  if (coords.kind === 'mirror-project') {
    // SSM:    /mirror/current/mongodb-shared/{endpoint,port,replica-set-name,ca-secret-arn}
    // Secret: /mirror/current/{project}-mongo-password
    const [endpoint, port, replicaSetName, caSecretArn] = await Promise.all([
      readSsm(ssm, '/mirror/current/mongodb-shared/endpoint'),
      readSsm(ssm, '/mirror/current/mongodb-shared/port'),
      readSsm(ssm, '/mirror/current/mongodb-shared/replica-set-name'),
      readSsm(ssm, '/mirror/current/mongodb-shared/ca-secret-arn'),
    ]);

    const [caBundle, projectCreds] = await Promise.all([
      readSecretJson<{ ca_cert: string }>(sm, caSecretArn),
      readSecretJson<{ username: string; password: string }>(
        sm,
        `/mirror/current/${project}-mongo-password`,
      ),
    ]);

    return {
      configType: 'MONGO',
      instanceName,
      hosts: [`${endpoint}:${port}`],
      database: dbName,
      username: projectCreds.username,
      password: projectCreds.password,
      replicaSet: replicaSetName,
      authSource: dbName,
      tls: true,
      tlsCAContent: caBundle.ca_cert,
    };
  }

  if (coords.kind === 'shared') {
    const [hostsCsv, replicaSetName, caSecretArn] = await Promise.all([
      readSsm(ssm, `${coords.ssmPrefix}/mongodb-hosts`),
      readSsm(ssm, `${coords.ssmPrefix}/mongodb-replica-set-name`),
      readSsm(ssm, `${coords.ssmPrefix}/mongodb-ca-secret-arn`),
    ]);

    const [caBundle, projectCreds] = await Promise.all([
      readSecretJson<{ ca_cert: string }>(sm, caSecretArn),
      readSecretJson<{ username: string; password: string }>(
        sm,
        `${coords.secretPrefix}/${project}-password`,
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

  // coords.kind === 'mirror-current'
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
