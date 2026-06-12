import 'reflect-metadata';
import { injectable } from 'inversify';
import { Pool, type PoolClient } from 'pg';
import type { PostgresProviderConfig } from './postgres-provider-config.js';
import type {
  PostgresPoolConfig,
  PostgresSslConfig,
} from './aws-postgres-loader.js';

/**
 * Manages a single ``pg.Pool`` for one logical database. Provider is
 * ORM-agnostic — consumers wrap the pool with Prisma (``PrismaPg``),
 * Drizzle, or use it directly.
 *
 * Accepts either config shape, so the same provider serves every env:
 *
 *   - a static {@link PostgresProviderConfig} (validated via
 *     ``PostgresProviderSchema``) for dev/local or any static-credential DB;
 *   - a {@link PostgresPoolConfig} straight from
 *     {@link loadPostgresConfigFromAws}, **including the mirror/prod IAM
 *     shape** whose ``password`` is an async callback that mints a fresh
 *     15-min RDS auth token. ``pg`` invokes the callback once per new
 *     physical connection, so pooled connections re-authenticate with a
 *     fresh token automatically.
 *
 * Routing the IAM path through the provider (rather than a hand-rolled
 * ``new Pool(...)`` per call site) is what lets RDS consumers inherit the
 * resilience below for free:
 *
 *   const provider = new PostgresProvider(
 *     await loadPostgresConfigFromAws({ env: 'prod', service: 'chat-api', ... }),
 *   );
 *   await provider.connect();
 *   const adapter = new PrismaPg(provider.getPool());
 *   const client = new PrismaClient({ adapter });
 *
 * Connection failures retry with exponential backoff (3 attempts, 1s base).
 *
 * Resilience: TCP keepAlive is enabled so half-open sockets (RDS failover,
 * NAT/LB idle drops) are detected proactively, and an ``'error'`` listener
 * is attached so an error on an *idle* pooled client cannot bubble out as an
 * uncaught exception and crash the process. The pool self-heals — it
 * discards the dead client and opens a fresh one (re-running the password
 * callback for a fresh IAM token) on the next acquire — so no manual
 * reconnect is required.
 */

/**
 * Pool-tuning defaults applied when a {@link PostgresPoolConfig} omits them.
 * Mirror ``PostgresProviderSchema``'s defaults so the static and AWS-loader
 * paths behave identically.
 */
const POOL_DEFAULTS = {
  poolSize: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 0,
  lockTimeoutMs: 0,
  // Safety guard, defaults ON (see PostgresProviderSchema) — bounds the
  // adapter-pg ack'd-but-not-durable leak (gh-186).
  idleInTransactionSessionTimeoutMs: 30_000,
} as const;

/** Internal canonical shape both accepted configs normalize into. */
interface NormalizedConfig {
  instanceName: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | (() => Promise<string>);
  ssl: boolean | PostgresSslConfig;
  poolSize: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
}

@injectable()
export class PostgresProvider {
  public readonly instanceName: string;
  private pool: Pool | null = null;
  private _isConnected = false;
  private readonly cfg: NormalizedConfig;

  constructor(config: PostgresProviderConfig | PostgresPoolConfig) {
    this.cfg = PostgresProvider.normalize(config);
    this.instanceName = this.cfg.instanceName;
  }

  async connect(): Promise<void> {
    // Guard on the pool itself, not _isConnected. An idle-client error
    // flips _isConnected to false (see the 'error' handler below) while
    // the pool stays alive and self-heals; keying off _isConnected here
    // would let a second connect() build a new pool and leak the first.
    if (this.pool) return;

    const maxRetries = 3;
    const baseDelayMs = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.pool = new Pool({
          host: this.cfg.host,
          port: this.cfg.port,
          database: this.cfg.database,
          user: this.cfg.user,
          // Static string (dev) or async token callback (mirror/prod IAM).
          // Built from discrete options rather than a connection string
          // specifically because pg ignores a discrete password when a
          // connectionString is also present — the callback would be lost.
          password: this.cfg.password,
          // ssl:true => full cert verification against Node's default CA
          // bundle (equivalent to the previous `sslmode=require`, which pg
          // maps to {}). Pass a PostgresSslConfig object instead to pin a CA
          // bundle (e.g. the Amazon RDS roots, which aren't always in Node's
          // default trust store) — pg forwards it verbatim to tls.connect.
          // ssl:false for local dev.
          ssl: this.cfg.ssl,
          max: this.cfg.poolSize,
          idleTimeoutMillis: this.cfg.idleTimeoutMs,
          connectionTimeoutMillis: this.cfg.connectionTimeoutMs,
          // Detect half-open sockets (RDS failover, NAT/LB idle drops)
          // proactively instead of only on the next query.
          keepAlive: true,
        });

        // Without this listener, an error on an *idle* pooled client
        // (RDS reboot/failover, network partition) is emitted on the Pool
        // with no handler — Node re-throws it as an uncaught exception and
        // crashes the process. Handle it: mark unhealthy + log. The pool
        // discards the dead client and reconnects on the next acquire.
        this.pool.on('error', (err: Error) => {
          this._isConnected = false;
          console.error(
            `[PostgresProvider:${this.instanceName}] idle client error; ` +
              `pool will reconnect on next use:`,
            err,
          );
        });

        if (
          this.cfg.statementTimeoutMs > 0 ||
          this.cfg.lockTimeoutMs > 0 ||
          this.cfg.idleInTransactionSessionTimeoutMs > 0
        ) {
          this.pool.on('connect', (client: PoolClient) => {
            // Fire-and-forget, but swallow rejections: an unhandled
            // rejection here (SET against a dying backend) is another
            // uncaught-exception path.
            if (this.cfg.statementTimeoutMs > 0) {
              client
                .query(`SET statement_timeout = ${this.cfg.statementTimeoutMs}`)
                .catch(() => {});
            }
            if (this.cfg.lockTimeoutMs > 0) {
              client
                .query(`SET lock_timeout = ${this.cfg.lockTimeoutMs}`)
                .catch(() => {});
            }
            // Safety guard (gh-186): reap connections left idle-in-transaction
            // (e.g. an adapter-pg discard that released without ROLLBACK).
            if (this.cfg.idleInTransactionSessionTimeoutMs > 0) {
              client
                .query(
                  `SET idle_in_transaction_session_timeout = ${this.cfg.idleInTransactionSessionTimeoutMs}`,
                )
                .catch(() => {});
            }
          });
        }

        // Validate by acquiring + releasing one connection. We do this
        // rather than relying on Pool's lazy connect so a bad
        // host/credential fails fast at connect() rather than on the
        // first query.
        const probe = await this.pool.connect();
        probe.release();

        this._isConnected = true;
        return;
      } catch (err) {
        if (this.pool) {
          await this.pool.end().catch(() => {});
          this.pool = null;
        }
        if (attempt === maxRetries) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * Math.pow(2, attempt - 1)),
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this._isConnected = false;
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  /** Returns the underlying ``Pool``. Throws if not connected. */
  getPool(): Pool {
    if (!this.pool) {
      throw new Error('PostgresProvider is not connected. Call connect() first.');
    }
    return this.pool;
  }

  /**
   * Normalize either accepted config shape into the internal canonical form.
   * {@link PostgresPoolConfig} (loader output) uses ``user`` and may omit
   * pool tuning; {@link PostgresProviderConfig} (zod schema) uses
   * ``username`` and always carries tuning (via schema defaults).
   */
  private static normalize(
    config: PostgresProviderConfig | PostgresPoolConfig,
  ): NormalizedConfig {
    if ('user' in config) {
      return {
        instanceName: config.instanceName,
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl,
        poolSize: config.poolSize ?? POOL_DEFAULTS.poolSize,
        idleTimeoutMs: config.idleTimeoutMs ?? POOL_DEFAULTS.idleTimeoutMs,
        connectionTimeoutMs:
          config.connectionTimeoutMs ?? POOL_DEFAULTS.connectionTimeoutMs,
        statementTimeoutMs:
          config.statementTimeoutMs ?? POOL_DEFAULTS.statementTimeoutMs,
        lockTimeoutMs: config.lockTimeoutMs ?? POOL_DEFAULTS.lockTimeoutMs,
        idleInTransactionSessionTimeoutMs:
          config.idleInTransactionSessionTimeoutMs ??
          POOL_DEFAULTS.idleInTransactionSessionTimeoutMs,
      };
    }

    return {
      instanceName: config.instanceName,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl,
      poolSize: config.poolSize,
      idleTimeoutMs: config.idleTimeoutMs,
      connectionTimeoutMs: config.connectionTimeoutMs,
      statementTimeoutMs: config.statementTimeoutMs,
      lockTimeoutMs: config.lockTimeoutMs,
      idleInTransactionSessionTimeoutMs: config.idleInTransactionSessionTimeoutMs,
    };
  }
}
