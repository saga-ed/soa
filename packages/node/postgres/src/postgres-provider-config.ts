import { z } from 'zod';

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

  // TLS toggle. Required for managed RDS / RDS Proxy connections.
  // Dev db-host containers can leave this off.
  ssl: z.boolean().default(false),

  // Optional pool tuning. Sensible defaults for an API service.
  poolSize: z.number().int().positive().default(10),
  idleTimeoutMs: z.number().int().nonnegative().default(30_000),
  connectionTimeoutMs: z.number().int().positive().default(10_000),

  // Per-connection session-level timeouts. 0 disables.
  // Default 0 (disabled) — services that want statement deadlines
  // should set these explicitly.
  statementTimeoutMs: z.number().int().nonnegative().default(0),
  lockTimeoutMs: z.number().int().nonnegative().default(0),
});

export type PostgresProviderConfig = z.infer<typeof PostgresProviderSchema>;
