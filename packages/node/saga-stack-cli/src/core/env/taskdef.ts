/**
 * ECS task-definition → database-target extraction (soa#355) — PURE.
 *
 * Live discovery (2026-07-21, dev account) showed the mesh's DB wiring is
 * heterogeneous but always lives in the service's OWN task definition, in one
 * of two shapes:
 *
 *   URL shape    — a `DATABASE_URL` container secret whose Secrets Manager
 *                  value is the full connection URL (iam-api →
 *                  `rostering/dev/database-url` → db-host-v2 CloudMap DNS;
 *                  program-hub apps; coach → the shared RDS).
 *   SPLIT shape  — `POSTGRES_{HOST,PORT,DATABASE,USERNAME}` container env vars
 *                  plus a `POSTGRES_PASSWORD` secret (ads-adm-api).
 *
 * Resolving from the task definition instead of hardcoded parameter names is
 * what makes `env connect` self-maintaining across environments: the SAME
 * service on `training` differs only by its `-training` name suffix, and a
 * service that moves stores updates itself. This module is the pure half —
 * given the described containers, say WHERE the target is; the command layer
 * fetches the referenced secrets through the aws seam.
 */

export interface TaskDefContainer {
  name?: string;
  environment?: { name?: string; value?: string }[];
  secrets?: { name?: string; valueFrom?: string }[];
}

/** A reference that still needs fetching: Secrets Manager ARN/name or SSM parameter ARN. */
export interface SecretRef {
  valueFrom: string;
  /** Which AWS service the ref points at (SSM parameter ARNs appear in `secrets` too). */
  kind: 'secretsmanager' | 'ssm';
}

export type DbTarget =
  | { shape: 'url'; urlSecret: SecretRef }
  | {
      shape: 'split';
      host: string;
      port: number;
      database: string;
      username?: string;
      passwordSecret?: SecretRef;
    };

const refKind = (valueFrom: string): SecretRef['kind'] =>
  valueFrom.startsWith('arn:aws:ssm:') ? 'ssm' : 'secretsmanager';

/**
 * Find the database target in a task definition's containers. URL shape wins
 * when both somehow exist; undefined when neither shape is present.
 */
export function extractDbTarget(containers: readonly TaskDefContainer[]): DbTarget | undefined {
  for (const c of containers) {
    const urlSecret = (c.secrets ?? []).find((s) => s.name === 'DATABASE_URL' && s.valueFrom !== undefined);
    if (urlSecret?.valueFrom !== undefined) {
      return { shape: 'url', urlSecret: { valueFrom: urlSecret.valueFrom, kind: refKind(urlSecret.valueFrom) } };
    }
  }
  for (const c of containers) {
    const env = new Map((c.environment ?? []).map((e) => [e.name ?? '', e.value ?? '']));
    const host = env.get('POSTGRES_HOST');
    if (host === undefined || host === '') continue;
    const password = (c.secrets ?? []).find((s) => s.name === 'POSTGRES_PASSWORD' && s.valueFrom !== undefined);
    return {
      shape: 'split',
      host,
      port: Number(env.get('POSTGRES_PORT') ?? '5432'),
      database: env.get('POSTGRES_DATABASE') ?? 'postgres',
      username: env.get('POSTGRES_USERNAME'),
      passwordSecret:
        password?.valueFrom === undefined ? undefined : { valueFrom: password.valueFrom, kind: refKind(password.valueFrom) },
    };
  }
  return undefined;
}

export interface ParsedDbUrl {
  host: string;
  port: number;
  database: string;
  username?: string;
  password?: string;
}

/** Parse a postgres:// / postgresql:// URL into its parts (throws on garbage). */
export function parseDatabaseUrl(raw: string): ParsedDbUrl {
  const u = new URL(raw);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`unsupported database URL scheme '${u.protocol}' (postgres/postgresql only)`);
  }
  return {
    host: u.hostname,
    port: u.port === '' ? 5432 : Number(u.port),
    database: u.pathname.replace(/^\//, ''),
    username: u.username === '' ? undefined : decodeURIComponent(u.username),
    password: u.password === '' ? undefined : decodeURIComponent(u.password),
  };
}

/** Rebuild a local (tunneled) connection URL from resolved parts. */
export function localUrl(parts: { username?: string; password?: string; database: string }, localPort: number): string {
  const auth =
    parts.username === undefined
      ? ''
      : `${encodeURIComponent(parts.username)}${parts.password === undefined ? '' : `:${encodeURIComponent(parts.password)}`}@`;
  return `postgres://${auth}127.0.0.1:${localPort}/${parts.database}`;
}
