import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { Signer } from '@aws-sdk/rds-signer';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

/**
 * Build a ready-to-use ``pg.Pool``-compatible config for a Saga service's
 * Postgres connection.
 *
 *   loadPostgresConfigFromAws({
 *     credentialSource: 'iam-token',
 *     coords: { hostSsmPath, portSsmPath },
 *     tls: { required: true, caBundlePath },
 *     service: 'chat-api', role: 'app', instanceName: 'ChatDB',
 *   })
 *
 * `credentialSource: 'static'` reads the dev parity secret instead. The legacy
 * `env` form is deprecated and maps onto the same path:
 *
 * **Legacy env behavior:**
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
export interface LoadPostgresConfigBase {
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

  /**
   * Transport security (required in the capability form). Omitted under legacy
   * `env`: iam-token → `true`, static → `false`.
   * Not required → `false`; required → `true`; required with `caBundlePath`
   * → RDS CA bundle plus Node's default roots, `rejectUnauthorized: true`.
   */
  tls?: PostgresTlsCapability;
}

export interface PostgresTlsCapability {
  required: boolean;
  caBundlePath?: string;
}

/** IAM-token coordinates; no default so a dev-lane caller can never fall through to /prod paths. */
export interface PostgresIamCoords {
  hostSsmPath: string;
  portSsmPath: string;
}

/** Capability form: pass `credentialSource` (and `coords` for `iam-token`). */
export interface LoadPostgresConfigByCapability extends LoadPostgresConfigBase {
  credentialSource: 'iam-token' | 'static';
  /** Required: no silent per-branch TLS default in the capability form. */
  tls: PostgresTlsCapability;
  /** Required when `credentialSource` is `'iam-token'`. */
  coords?: PostgresIamCoords;
  /** @deprecated Mutually exclusive with `credentialSource`. */
  env?: never;
}

/** @deprecated Pass `credentialSource` (+ `coords`) instead (soa#515). */
export interface LoadPostgresConfigByEnv extends LoadPostgresConfigBase {
  env: 'dev' | 'mirror' | 'prod';
  credentialSource?: never;
  coords?: never;
}

export type LoadPostgresConfigParams =
  | LoadPostgresConfigByCapability
  | LoadPostgresConfigByEnv;

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
  // gh-186 guard; the provider defaults it to 0 (off) when omitted.
  idleInTransactionSessionTimeoutMs?: number;
}

const DEFAULT_REGION = 'us-west-2';

const LEGACY_ENV_CREDENTIAL_SOURCE: Record<
  'dev' | 'mirror' | 'prod',
  'iam-token' | 'static'
> = { dev: 'static', mirror: 'iam-token', prod: 'iam-token' };

let legacyEnvWarned = false;

function warnLegacyEnvOnce(): void {
  if (legacyEnvWarned) return;
  legacyEnvWarned = true;
  process.emitWarning(
    "loadPostgresConfigFromAws: the 'env' parameter is deprecated; pass 'credentialSource' (+ 'coords' for iam-token) and 'tls' instead.",
    { type: 'DeprecationWarning', code: 'SOA_ENV_FALLBACK_POSTGRES_ENV' },
  );
}

function resolveSsl(
  tls: PostgresTlsCapability | undefined,
  fallback: boolean,
): boolean | PostgresSslConfig {
  if (!tls) return fallback;
  if (!tls.required) return false;
  if (!tls.caBundlePath) return true;
  // RDS bundle (direct endpoint) + Node roots (RDS Proxy certs chain to Amazon Trust Services).
  return {
    ca: [readFileSync(tls.caBundlePath, 'utf8'), ...rootCertificates],
    rejectUnauthorized: true,
  };
}

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

  const hasEnv = params.env !== undefined;
  const hasSource = params.credentialSource !== undefined;
  if (hasEnv === hasSource) {
    throw new Error(
      "loadPostgresConfigFromAws: pass exactly one of 'env' (deprecated) or 'credentialSource'",
    );
  }

  let credentialSource: 'iam-token' | 'static';
  let coords: PostgresIamCoords | undefined;
  if (params.env !== undefined) {
    warnLegacyEnvOnce();
    credentialSource = LEGACY_ENV_CREDENTIAL_SOURCE[params.env];
    if (credentialSource === 'iam-token') {
      // Narrowed: env is 'mirror' | 'prod' here.
      const iamEnv = params.env as 'mirror' | 'prod';
      coords = {
        hostSsmPath: iamHostSsmPath(iamEnv),
        portSsmPath: iamPortSsmPath(iamEnv),
      };
    }
  } else {
    credentialSource = params.credentialSource as 'iam-token' | 'static';
    coords = params.coords;
    if (!params.tls) {
      throw new Error(
        "loadPostgresConfigFromAws: the capability form requires explicit 'tls' (no default TLS posture)",
      );
    }
    if (credentialSource === 'iam-token' && !coords) {
      throw new Error(
        "loadPostgresConfigFromAws: credentialSource 'iam-token' requires explicit 'coords' (no default SSM paths)",
      );
    }
  }

  if (credentialSource === 'static') {
    return loadStaticConfig({
      service: params.service,
      role,
      instanceName: params.instanceName,
      dbId: params.dbId,
      username,
      database,
      region,
      ssl: resolveSsl(params.tls, false),
    });
  }

  return loadIamConfig({
    coords: coords as PostgresIamCoords,
    instanceName: params.instanceName,
    username,
    database,
    region,
    ssl: resolveSsl(params.tls, true),
  });
}

/**
 * Static path: read the parity SM secret + return config with the static
 * password. The parity entry is written by
 * ``saga-provision-credentials create --env dev --insecure-dev`` and
 * contains the role's hardcoded local-docker password.
 */
async function loadStaticConfig(args: {
  service: string;
  role: 'owner' | 'app' | 'ro';
  instanceName: string;
  dbId?: string;
  username: string;
  database: string;
  region: string;
  ssl: boolean | PostgresSslConfig;
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
    ssl: args.ssl,
  };
}

/**
 * IAM path: coords from SSM; password is an async callback that mints a
 * fresh 15-min token per new pool connection.
 *
 * `pg.Pool` calls the password callback once per connection establishment
 * (not once per query). Long-lived pooled connections survive past the
 * 15-min token TTL because Postgres only validates the token at connect
 * time. New connections (pool refill, scale-out) get fresh tokens.
 */
async function loadIamConfig(args: {
  coords: PostgresIamCoords;
  instanceName: string;
  username: string;
  database: string;
  region: string;
  ssl: boolean | PostgresSslConfig;
}): Promise<PostgresPoolConfig> {
  const ssm = new SSMClient({ region: args.region });
  const [host, portRaw] = await Promise.all([
    readSsm(ssm, args.coords.hostSsmPath),
    readSsm(ssm, args.coords.portSsmPath),
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
    ssl: args.ssl,
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
  return IAM_SSM_PATHS[env].host;
}

export function iamPortSsmPath(env: 'mirror' | 'prod'): string {
  return IAM_SSM_PATHS[env].port;
}

const IAM_SSM_PATHS: Record<'mirror' | 'prod', { host: string; port: string }> = {
  mirror: {
    host: '/mirror/current/postgres-rds/endpoint',
    port: '/mirror/current/postgres-rds/port',
  },
  prod: {
    host: '/prod/postgres-rds/endpoint',
    port: '/prod/postgres-rds/port',
  },
};

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
