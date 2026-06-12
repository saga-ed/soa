import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { Signer } from '@aws-sdk/rds-signer';

/**
 * Build a ready-to-use ``pg.Pool``-compatible config for a Saga service's
 * Postgres connection. Handles all three envs via the same call:
 *
 *   loadPostgresConfigFromAws({ env: 'prod', service: 'chat-api', role: 'app',
 *                               instanceName: 'ChatDB' })
 *
 * **Env behavior:**
 *
 * - `'prod'`   — IAM-auth against shared RDS in prod account. Coords
 *                (host/port) come from SSM `/shared/infra/prod/postgres-{host,port}`.
 *                Database is derived as ``{service_snake}`` unless overridden
 *                in the per-service spec (multi-DB services pass ``dbId`` to
 *                pick the right one). Password is an async callback that
 *                mints a 15-min IAM token via ``@aws-sdk/rds-signer`` on
 *                every new pool connection.
 *
 * - `'mirror'` — Same as prod but coords come from
 *                ``/mirror/current/postgres-rds/{endpoint,port}``. Mirror is
 *                in the dev account but otherwise prod-shape.
 *
 * - `'dev'`    — Local docker / db-host container. No IAM. Reads the
 *                parity secret written by ``saga-provision-credentials
 *                create --env dev --insecure-dev`` at
 *                ``dev/postgres-shared/{service}/{role}``. Returns
 *                a static password string. For services not using the
 *                parity flow, this loader isn't the right tool — construct
 *                config directly from env vars.
 *
 * **Naming convention** (derived; spec-overridable in iac):
 *
 *   username = `{service_snake}_{role}`   (e.g. chat_app)
 *   database = `{service_snake}`           (e.g. chat)
 *
 * Where `service_snake = service.replace(/-/g, '_')` so spec ids with
 * hyphens (`chat-api`) become valid Postgres identifiers (`chat_api`).
 *
 * **Multi-DB postgres** (rostering iam-api → iam_db + iam_pii_db):
 * pass ``dbId`` to select; the database becomes ``{service_snake}_{dbId}_db``
 * or whatever the spec declares.
 */
export interface LoadPostgresConfigParams {
  env: 'dev' | 'mirror' | 'prod';

  /** Service name as it appears in `db-access.yaml` (e.g. 'chat-api'). */
  service: string;

  /**
   * Postgres role suffix. Maps onto the per-service role triplet:
   *   'owner' — DDL / migrations (AppInfra tier or owner-only contexts)
   *   'app'   — DML runtime (the most common case; default)
   *   'ro'    — SELECT only (reports, debugging)
   */
  role?: 'owner' | 'app' | 'ro';

  /** Name to give the resulting PostgresProvider / pool. */
  instanceName: string;

  /**
   * For multi-DB services (e.g. rostering iam-api with iam_db + iam_pii_db),
   * the database id from db-access.yaml. Omit for single-DB services.
   */
  dbId?: string;

  /**
   * Override the auto-derived database name. Defaults to
   * ``{service_snake}`` (or ``{service_snake}_{dbId}`` for multi-DB).
   * Use this for legacy schemas that don't follow the convention.
   */
  database?: string;

  /**
   * Override the auto-derived username. Defaults to
   * ``{service_snake}_{role}``. Use for services whose role names
   * predate this convention (e.g. `saga_api` writers).
   */
  username?: string;

  /** AWS region. Defaults to us-west-2 (Saga's only region today). */
  region?: string;
}

/**
 * TLS options for a Postgres connection — a structural subset of Node's
 * ``tls.ConnectionOptions`` that ``pg`` forwards verbatim to ``tls.connect``.
 *
 * Use this object form (instead of a bare ``true``) when the server cert
 * chains to a root that is **not** in Node's default trust store — most
 * notably to pin the Amazon RDS CA bundle for managed RDS:
 *
 *   {
 *     ca: readFileSync(process.env.PG_RDS_CA_BUNDLE_PATH, 'utf8'),
 *     rejectUnauthorized: true,
 *   }
 *
 * ``ssl: true`` keeps full verification against Node's default CA bundle;
 * ``ssl: false`` disables TLS (local dev).
 */
export interface PostgresSslConfig {
  /** CA cert(s) to trust (PEM). Pin the RDS CA bundle here. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Verify the server cert against `ca` / the default store. Defaults true. */
  rejectUnauthorized?: boolean;
  /** Client cert (PEM) for mutual TLS. */
  cert?: string | Buffer | Array<string | Buffer>;
  /** Client private key (PEM) for mutual TLS. */
  key?: string | Buffer | Array<string | Buffer>;
  /** SNI / cert-identity hostname override. */
  servername?: string;
}

/**
 * `pg.Pool`-compatible config returned by the loader. The `password`
 * field is a union: a static string for dev (parity secret) or an
 * async callback for mirror/prod (mints IAM token per new pool
 * connection). `pg.Pool` natively accepts both shapes.
 *
 * `ssl` is `boolean | PostgresSslConfig`: the loader returns a bare
 * `true`/`false`, but a consumer may override it with a {@link
 * PostgresSslConfig} (e.g. pinning the RDS CA bundle) before handing the
 * config to {@link PostgresProvider}.
 */
export interface PostgresPoolConfig {
  instanceName: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | (() => Promise<string>);
  ssl: boolean | PostgresSslConfig;

  // Optional pool tuning. `PostgresProvider` applies conservative defaults
  // (matching `PostgresProviderSchema`) when these are omitted, so the
  // loader output can be handed straight to the provider — including the
  // IAM mirror/prod shape whose `password` is the async token callback.
  poolSize?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  // Safety guard (gh-186); the provider defaults it ON (30s) when omitted.
  idleInTransactionSessionTimeoutMs?: number;
}

const DEFAULT_REGION = 'us-west-2';

export async function loadPostgresConfigFromAws(
  params: LoadPostgresConfigParams,
): Promise<PostgresPoolConfig> {
  const region = params.region ?? DEFAULT_REGION;
  const role = params.role ?? 'app';
  const serviceSnake = params.service.replace(/-/g, '_');

  const username =
    params.username ?? `${serviceSnake}_${role}`;
  const database =
    params.database ?? (params.dbId ? `${serviceSnake}_${params.dbId}_db` : serviceSnake);

  if (params.env === 'dev') {
    return loadDevConfig({
      service: params.service,
      role,
      instanceName: params.instanceName,
      dbId: params.dbId,
      username,
      database,
      region,
    });
  }

  return loadIamConfig({
    env: params.env,
    instanceName: params.instanceName,
    username,
    database,
    region,
  });
}

/**
 * Dev path: read the parity SM secret + return config with the static
 * password. The parity entry is written by
 * ``saga-provision-credentials create --env dev --insecure-dev`` and
 * contains the role's hardcoded local-docker password.
 */
async function loadDevConfig(args: {
  service: string;
  role: 'owner' | 'app' | 'ro';
  instanceName: string;
  dbId?: string;
  username: string;
  database: string;
  region: string;
}): Promise<PostgresPoolConfig> {
  const sm = new SecretsManagerClient({ region: args.region });
  const secretId = devSecretName(args.service, args.role, args.dbId);
  const raw = await readSecretJson<DevSecretPayload>(sm, secretId);
  return {
    instanceName: args.instanceName,
    host: raw.host,
    port: typeof raw.port === 'string' ? parseInt(raw.port, 10) : raw.port,
    database: raw.database ?? raw.dbname ?? args.database,
    user: raw.username ?? args.username,
    password: raw.password,
    ssl: false,
  };
}

/**
 * Mirror/prod path: IAM auth. Coords from SSM; password is an async
 * callback that mints a fresh 15-min token per new pool connection.
 *
 * `pg.Pool` calls the password callback once per connection establishment
 * (not once per query). Long-lived pooled connections survive past the
 * 15-min token TTL because Postgres only validates the token at connect
 * time. New connections (pool refill, scale-out) get fresh tokens.
 */
async function loadIamConfig(args: {
  env: 'mirror' | 'prod';
  instanceName: string;
  username: string;
  database: string;
  region: string;
}): Promise<PostgresPoolConfig> {
  const ssm = new SSMClient({ region: args.region });
  const [host, portRaw] = await Promise.all([
    readSsm(ssm, iamHostSsmPath(args.env)),
    readSsm(ssm, iamPortSsmPath(args.env)),
  ]);
  const port = parseInt(portRaw, 10);

  // Critical: the Signer must use the REAL RDS hostname + port (5432).
  // RDS validates the token against the actual listener, not against the
  // local tunnel port (15432) when running over SSM port-forwarding.
  // pg.Pool can connect to localhost:tunnelPort if desired — but the
  // Signer always signs for the real endpoint.
  const signer = new Signer({
    hostname: host,
    port,
    username: args.username,
    region: args.region,
  });

  return {
    instanceName: args.instanceName,
    host,
    port,
    database: args.database,
    user: args.username,
    ssl: true,
    password: async () => signer.getAuthToken(),
  };
}

// ---------------------------------------------------------------------------
// Path helpers (exported for consumers that need to compute the same paths
// in IAM policies, deploy scripts, etc.)
// ---------------------------------------------------------------------------

/**
 * SSM path for the shared Postgres host. Canonical pattern is
 * `/{tier}/postgres-rds/{coord}` for both mirror and prod — they share
 * the same shape; mirror's "tier" is `mirror/current` because the daily
 * refresh workflow rolls instances under that namespace.
 */
export function iamHostSsmPath(env: 'mirror' | 'prod'): string {
  return env === 'mirror'
    ? '/mirror/current/postgres-rds/endpoint'
    : '/prod/postgres-rds/endpoint';
}

export function iamPortSsmPath(env: 'mirror' | 'prod'): string {
  return env === 'mirror'
    ? '/mirror/current/postgres-rds/port'
    : '/prod/postgres-rds/port';
}

/**
 * Dev parity SM secret name (one per service per role, optionally per dbId
 * for multi-DB services). Written by ``saga-provision-credentials --env
 * dev --insecure-dev``.
 */
export function devSecretName(
  service: string,
  role: 'owner' | 'app' | 'ro',
  dbId?: string,
): string {
  const idPart = dbId ? `${service}/${dbId}/${role}` : `${service}/${role}`;
  return `dev/postgres-shared/${idPart}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DevSecretPayload {
  username?: string;
  password: string;
  host: string;
  port: number | string;
  database?: string;
  /** Mirror refresh workflow legacy alias; not used in dev but tolerated. */
  dbname?: string;
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
  if (!value) {
    throw new Error(`SSM parameter ${name} has no value`);
  }
  return value;
}
