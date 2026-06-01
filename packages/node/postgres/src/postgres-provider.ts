import 'reflect-metadata';
import { injectable } from 'inversify';
import { Pool, type PoolClient } from 'pg';
import type { PostgresProviderConfig } from './postgres-provider-config.js';

/**
 * Manages a single ``pg.Pool`` for one logical database. Provider is
 * ORM-agnostic — consumers wrap the pool with Prisma (``PrismaPg``),
 * Drizzle, or use it directly.
 *
 * Lifted from student-data-system/packages/node/ads-adm-db with the
 * Prisma coupling removed so this package stays a thin postgres-only
 * library. Consumers that want Prisma adapt the pool themselves:
 *
 *   const provider = new PostgresProvider(config);
 *   await provider.connect();
 *   const adapter = new PrismaPg(provider.getPool());
 *   const client = new PrismaClient({ adapter });
 *
 * Connection failures retry with exponential backoff (3 attempts, 1s
 * base) — matches the original implementation.
 *
 * Resilience: TCP keepAlive is enabled so half-open sockets (RDS
 * failover, NAT/LB idle drops) are detected proactively, and an
 * ``'error'`` listener is attached to the pool so an error on an *idle*
 * pooled client cannot bubble out as an uncaught exception and crash the
 * process. The pool self-heals — it discards the dead client and opens a
 * fresh one on the next acquire — so no manual reconnect is required.
 */
@injectable()
export class PostgresProvider {
  public readonly instanceName: string;
  private pool: Pool | null = null;
  private _isConnected = false;

  constructor(private readonly config: PostgresProviderConfig) {
    this.instanceName = config.instanceName;
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
          connectionString: this.buildConnectionString(),
          max: this.config.poolSize,
          idleTimeoutMillis: this.config.idleTimeoutMs,
          connectionTimeoutMillis: this.config.connectionTimeoutMs,
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

        if (this.config.statementTimeoutMs > 0 || this.config.lockTimeoutMs > 0) {
          this.pool.on('connect', (client: PoolClient) => {
            // Fire-and-forget, but swallow rejections: an unhandled
            // rejection here (SET against a dying backend) is another
            // uncaught-exception path.
            if (this.config.statementTimeoutMs > 0) {
              client
                .query(`SET statement_timeout = ${this.config.statementTimeoutMs}`)
                .catch(() => {});
            }
            if (this.config.lockTimeoutMs > 0) {
              client
                .query(`SET lock_timeout = ${this.config.lockTimeoutMs}`)
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

  /** Build the postgres:// connection string from config. */
  private buildConnectionString(): string {
    const { host, port, database, username, password, ssl } = this.config;
    const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    const sslParam = ssl ? '?sslmode=require' : '';
    return `postgresql://${auth}${host}:${port}/${database}${sslParam}`;
  }
}
