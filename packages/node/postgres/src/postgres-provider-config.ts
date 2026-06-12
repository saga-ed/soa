import { z } from 'zod';

/**
 * TLS options for a static {@link PostgresProviderConfig}. JSON-friendly
 * (PEM strings, not Buffers) since this path is parsed from a Secrets
 * Manager payload. Mirrors {@link PostgresSslConfig} from the loader so
 * both config shapes can pin a CA bundle (e.g. the Amazon RDS roots).
 */
export const PostgresSslSchema = z.object({
  ca: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
  cert: z.string().optional(),
  key: z.string().optional(),
  servername: z.string().optional(),
});

/**
 * Config schema for {@link PostgresProvider}.
 *
 * Matches the secret payload written by ``saga-provision-credentials``
 * for the postgres engine: `{username, password, host, port, database, engine}`.
 * The `engine` discriminator lets a shared secret store distinguish
 * engine types when consumers fetch by ARN.
 *
 * Pool tuning fields are provider-side knobs that don't belong in the
 * Secrets Manager payload — they're set per-consumer and default to
 * conservative values suitable for a typical API service.
 */
export const PostgresProviderSchema = z.object({
  configType: z.literal('POSTGRES').default('POSTGRES'),
  instanceName: z.string().min(1),

  // Connection target — matches the SM payload shape from
  // saga-provision-credentials: {username, password, host, port, database}.
  host: z.string().min(1),
  port: z.number().int().positive().default(5432),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),

  // TLS: `true`/`false` toggle, or a CA-pinning object (see
  // PostgresSslSchema) when the server cert chains to a root outside
  // Node's default trust store. Required for managed RDS / RDS Proxy;
  // dev db-host containers can leave this off.
  ssl: z.union([z.boolean(), PostgresSslSchema]).default(false),

  // Optional pool tuning. Sensible defaults for an API service.
  poolSize: z.number().int().positive().default(10),
  idleTimeoutMs: z.number().int().nonnegative().default(30_000),
  connectionTimeoutMs: z.number().int().positive().default(10_000),

  // Per-connection session-level timeouts. 0 disables.
  // Default 0 (disabled) — services that want statement deadlines
  // should set these explicitly.
  statementTimeoutMs: z.number().int().nonnegative().default(0),
  lockTimeoutMs: z.number().int().nonnegative().default(0),

  // Reap connections left `idle in transaction` past this many ms. Unlike the
  // two timeouts above (opt-in performance deadlines), this is a SAFETY GUARD
  // and defaults ON: it bounds the @prisma/adapter-pg "ack'd-but-not-durable"
  // leak (program-hub gh-186) where a $transaction discarded on a maxWait
  // timeout returns a connection to the pool still inside an open transaction
  // (released without ROLLBACK), so later writes are acknowledged but never
  // committed. 30s is safe — Prisma interactive-transaction bodies cap at 5s.
  // Set 0 to disable (e.g. a service with legitimate long idle-in-tx work).
  idleInTransactionSessionTimeoutMs: z.number().int().nonnegative().default(30_000),
});

export type PostgresProviderConfig = z.infer<typeof PostgresProviderSchema>;
