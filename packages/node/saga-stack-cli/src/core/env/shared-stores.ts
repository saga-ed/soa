/**
 * Shared-infra stores reachable through `ss env connect`: the MongoDB replica
 * set and the Amazon MQ RabbitMQ broker. Pure — no IO. Credentials are never
 * handled here: every builder emits a shell hint that substitutes the read-only
 * secret at run time.
 */

import type { DeployedEnv } from './registry.js';

export const SHARED_STORE_KEYS = ['mongo', 'rabbitmq'] as const;
export type SharedStoreKey = (typeof SHARED_STORE_KEYS)[number];

export const isSharedStore = (key: string): key is SharedStoreKey => (SHARED_STORE_KEYS as readonly string[]).includes(key);

export const DEFAULT_LOCAL_PORTS: Record<'postgres' | SharedStoreKey | 'rabbitmqAmqps', number> = {
  postgres: 15432,
  mongo: 27018,
  rabbitmq: 15443,
  rabbitmqAmqps: 15671,
};

/** Remote port for `--host` when `--remote-port` is not given. */
export const POSTGRES_REMOTE_PORT = 5432;

export const defaultLocalPort = (store: string): number =>
  isSharedStore(store) ? DEFAULT_LOCAL_PORTS[store] : DEFAULT_LOCAL_PORTS.postgres;

export interface MongoMember {
  host: string;
  port: number;
}

/** Parse the `host:port,host:port,…` SSM value; undefined-free, throws on malformed input. */
export const parseMongoHosts = (raw: string): MongoMember[] => {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) throw new Error('mongo hosts value is empty');
  return parts.map((p) => {
    const i = p.lastIndexOf(':');
    const host = i < 0 ? '' : p.slice(0, i);
    const port = Number(p.slice(i + 1));
    if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`malformed mongo member '${p}' — expected host:port`);
    }
    return { host, port };
  });
};

export const pickMongoMember = (members: MongoMember[], index: number): MongoMember => {
  const m = Number.isInteger(index) ? members[index] : undefined;
  if (m === undefined) throw new Error(`--member ${index} out of range — valid: 0..${members.length - 1}`);
  return m;
};

export const mongoMemberList = (members: MongoMember[], chosen: number): string[] =>
  members.map((m, i) => `${i === chosen ? '*' : ' '} ${i}: ${m.host}:${m.port}`);

export interface SharedParamsResult<T> {
  params?: T;
  refusal?: string;
}

export const mongoParamsFor = (env: DeployedEnv): SharedParamsResult<NonNullable<DeployedEnv['mongoParams']>> =>
  env.mongoParams === undefined
    ? { refusal: `'${env.name}' has no shared MongoDB replica set registered — nothing to connect to.` }
    : { params: env.mongoParams };

export const rabbitmqParamsFor = (env: DeployedEnv): SharedParamsResult<NonNullable<DeployedEnv['rabbitmqParams']>> =>
  env.rabbitmqParams === undefined
    ? { refusal: `'${env.name}' has no shared RabbitMQ broker registered — nothing to connect to.` }
    : { params: env.rabbitmqParams };

const profileArg = (profile: string | undefined): string => (profile === undefined ? '' : ` --profile ${profile}`);

/** Shell snippet that sets `MONGO_PW` (URL-encoded) from the ro secret at run time. */
export const mongoPasswordHint = (secretId: string, region: string, profile?: string): string =>
  `MONGO_PW="$(aws secretsmanager get-secret-value --secret-id ${secretId} --query SecretString --output text${profileArg(profile)} --region ${region} | python3 -c 'import json,sys,urllib.parse;print(urllib.parse.quote(json.load(sys.stdin)["password"],safe=""))')"`;

/** The CA cert fetch command, for --print-only (the CLI writes the file itself on a live tunnel). */
export const mongoCaFetchHint = (caCertParam: string, region: string, profile?: string): string =>
  `aws ssm get-parameter --name ${caCertParam} --query Parameter.Value --output text${profileArg(profile)} --region ${region} > mongo-ca.pem`;

export const MONGO_RO_USER = 'saga_ro';

/** Local connection URL carrying a `${MONGO_PW}` placeholder — never the password. */
export const mongoUrlTemplate = (localPort: number, caFile: string): string =>
  `mongodb://${MONGO_RO_USER}:\${MONGO_PW}@127.0.0.1:${localPort}/?directConnection=true&readPreference=secondaryPreferred&authSource=admin&tls=true&tlsCAFile=${caFile}&tlsAllowInvalidHostnames=true`;

export const MONGO_MEMBER_CHECK_HINT =
  'verify the member is read-only: run db.hello() and confirm secondary: true; if isWritablePrimary: true, rerun with another --member.';

export const MONGO_PROD_QUERY_HYGIENE = 'prod query hygiene: use indexed filters, always .limit(), always maxTimeMS.';

export const rabbitmqHost = (brokerId: string, region: string): string => `${brokerId}.mq.${region}.on.aws`;

/** Management API (HTTPS); the default `--remote-port`. */
export const RABBITMQ_PORT = 443;
export const RABBITMQ_AMQPS_PORT = 5671;
export const RABBITMQ_REMOTE_PORTS = [RABBITMQ_PORT, RABBITMQ_AMQPS_PORT] as const;
export const RABBITMQ_RO_USER = 'saga_ro';

/** Remote port for the broker tunnel: 443 unless asked; anything but 443/5671 is an error, never ignored. */
export const pickRabbitmqPort = (requested: number | undefined): number => {
  if (requested === undefined) return RABBITMQ_PORT;
  if (!(RABBITMQ_REMOTE_PORTS as readonly number[]).includes(requested)) {
    throw new Error(
      `--remote-port ${requested} is not a broker port — use ${RABBITMQ_PORT} (management API) or ${RABBITMQ_AMQPS_PORT} (AMQPS).`,
    );
  }
  return requested;
};

/**
 * Flag/store mismatches, checked before any AWS call. Shared stores resolve their
 * target and login from the registry, so target-override flags are refused, not ignored.
 */
export const connectFlagError = (
  store: string,
  f: { host?: string; username?: string; database?: string; remotePort?: number },
): string | undefined => {
  if (!isSharedStore(store)) {
    return f.remotePort !== undefined && f.host === undefined
      ? '--remote-port needs --host for a postgres store — the resolved target carries its own port.'
      : undefined;
  }
  const bad = (['host', 'username', 'database'] as const).filter((k) => f[k] !== undefined).map((k) => `--${k}`);
  if (store === 'mongo' && f.remotePort !== undefined) bad.push('--remote-port');
  if (bad.length > 0) {
    const why = store === 'mongo' ? ' (pick the member, and so the port, with --member)' : '';
    return `${bad.join(', ')} ${bad.length === 1 ? 'does' : 'do'} not apply to ${store} — its target and read-only login come from the env registry${why}.`;
  }
  if (store === 'rabbitmq') {
    try {
      pickRabbitmqPort(f.remotePort);
    } catch (err) {
      return (err as Error).message;
    }
  }
  return undefined;
};

/** Shell snippet that sets `MQ_PW` from the ro secret at run time. */
export const rabbitmqPasswordHint = (secretId: string, region: string, profile?: string): string =>
  `MQ_PW="$(aws secretsmanager get-secret-value --secret-id ${secretId} --query SecretString --output text${profileArg(profile)} --region ${region} | python3 -c 'import json,sys;print(json.load(sys.stdin)["password"])')"`;

/** Management API call through the tunnel; --connect-to keeps TLS hostname verification valid. */
export const rabbitmqCurlHint = (host: string, localPort: number): string =>
  `curl --connect-to ${host}:${RABBITMQ_PORT}:127.0.0.1:${localPort} -u "${RABBITMQ_RO_USER}:\${MQ_PW}" https://${host}/api/overview`;

/** AMQPS URL through the tunnel, `${MQ_PW}` placeholder only. The client must send SNI = broker host. */
export const rabbitmqAmqpsUrlTemplate = (localPort: number): string =>
  `amqps://${RABBITMQ_RO_USER}:\${MQ_PW}@127.0.0.1:${localPort}/`;

/** AMQPS smoke check: pika over the tunnel with TLS SNI + hostname verification against the broker cert. */
export const rabbitmqAmqpsCheckHint = (host: string, localPort: number): string =>
  `MQ_PW="$MQ_PW" python3 -c 'import os,ssl,pika;p=pika.ConnectionParameters(host="127.0.0.1",port=${localPort},credentials=pika.PlainCredentials("${RABBITMQ_RO_USER}",os.environ["MQ_PW"]),ssl_options=pika.SSLOptions(ssl.create_default_context(),server_hostname="${host}"));c=pika.BlockingConnection(p);print("AMQPS ok");c.close()'`;
