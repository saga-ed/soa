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

export const DEFAULT_LOCAL_PORTS: Record<'postgres' | SharedStoreKey, number> = {
  postgres: 15432,
  mongo: 27018,
  rabbitmq: 15443,
};

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

/** The CA fetch command, for --print-only (the CLI writes the file itself on a live tunnel). */
export const mongoCaFetchHint = (caSecretArn: string, region: string, profile?: string): string =>
  `aws secretsmanager get-secret-value --secret-id ${caSecretArn} --query SecretString --output text${profileArg(profile)} --region ${region} > mongo-ca.pem`;

export const MONGO_RO_USER = 'saga_ro';

/** Local connection URL carrying a `${MONGO_PW}` placeholder — never the password. */
export const mongoUrlTemplate = (localPort: number, caFile: string): string =>
  `mongodb://${MONGO_RO_USER}:\${MONGO_PW}@127.0.0.1:${localPort}/?directConnection=true&readPreference=secondaryPreferred&authSource=admin&tls=true&tlsCAFile=${caFile}&tlsAllowInvalidHostnames=true`;

export const MONGO_MEMBER_CHECK_HINT =
  'verify the member is read-only: run db.hello() and confirm secondary: true; if isWritablePrimary: true, rerun with another --member.';

export const MONGO_PROD_QUERY_HYGIENE = 'prod query hygiene: use indexed filters, always .limit(), always maxTimeMS.';

export const rabbitmqHost = (brokerId: string, region: string): string => `${brokerId}.mq.${region}.on.aws`;

export const RABBITMQ_PORT = 443;
export const RABBITMQ_RO_USER = 'saga_ro';

/** Shell snippet that sets `MQ_PW` from the ro secret at run time. */
export const rabbitmqPasswordHint = (secretId: string, region: string, profile?: string): string =>
  `MQ_PW="$(aws secretsmanager get-secret-value --secret-id ${secretId} --query SecretString --output text${profileArg(profile)} --region ${region} | python3 -c 'import json,sys;print(json.load(sys.stdin)["password"])')"`;

/** Management API call through the tunnel; --connect-to keeps TLS hostname verification valid. */
export const rabbitmqCurlHint = (host: string, localPort: number): string =>
  `curl --connect-to ${host}:${RABBITMQ_PORT}:127.0.0.1:${localPort} -u "${RABBITMQ_RO_USER}:\${MQ_PW}" https://${host}/api/overview`;
